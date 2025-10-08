/**
 * ============================================================
 * PJH Web Services — Stripe Payments & Billing
 * ============================================================
 * Supports:
 *  ✅ Card & Bacs one-off payments (via Checkout)
 *  ✅ Direct Debit setup (no charge)
 *  ✅ Monthly recurring charges (off-session)
 * ============================================================
 */
import express from "express";
import Stripe from "stripe";
import dotenv from "dotenv";
import pool from "../db.js";
import { sendEmail } from "../utils/email.js";
import {
  paymentRequestTemplate,
  paymentSuccessTemplate,
  paymentFailureTemplate,
} from "../utils/emailTemplates.js";

dotenv.config();
const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const FRONTEND_URL =
  process.env.FRONTEND_URL || "https://www.pjhwebservices.co.uk";

/* ============================================================
   🧾 Ensure Stripe Customer
============================================================ */
async function ensureStripeCustomer(customer) {
  if (customer.stripe_customer_id) return customer.stripe_customer_id;
  const sc = await stripe.customers.create({
    name: customer.name,
    email: customer.email,
    address: {
      line1: customer.address1 || "Unknown address",
      city: customer.city || "London",
      country: "GB",
      postal_code: customer.postcode || "EC1A 1AA",
    },
    metadata: { pjh_customer_id: customer.id },
  });
  await pool.query(
    "UPDATE customers SET stripe_customer_id=$1 WHERE id=$2",
    [sc.id, customer.id]
  );
  return sc.id;
}

/* ============================================================
   💳 Create Checkout (Card / Bacs / Setup)
============================================================ */
router.post("/create-checkout", async (req, res) => {
  try {
    const { orderId, flow, type } = req.body;

    if (!orderId) return res.status(400).json({ error: "Missing orderId" });
    if (!["card_payment", "bacs_payment", "bacs_setup"].includes(flow))
      return res.status(400).json({ error: "Invalid flow" });

    const { rows } = await pool.query(
      `SELECT o.*, c.id as cid, c.name, c.email, c.stripe_customer_id
       FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = $1`,
      [orderId]
    );
    if (!rows.length) return res.status(404).json({ error: "Order not found" });
    const order = rows[0];

    let amount = 0;
    if (["card_payment", "bacs_payment"].includes(flow)) {
      amount = type === "deposit" ? Number(order.deposit) : Number(order.balance);
      if (!amount || amount <= 0)
        return res.status(400).json({ error: "Invalid amount" });
    }

    const stripeCustomerId = await ensureStripeCustomer(order);
    const metadata = { order_id: order.id, customer_id: order.cid, payment_type: type || "general" };

    let session;
    if (flow === "card_payment") {
      session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer: stripeCustomerId,
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: "gbp",
              product_data: { name: `${type} — ${order.title}` },
              unit_amount: Math.round(amount * 100),
            },
            quantity: 1,
          },
        ],
        success_url: `${FRONTEND_URL}/payment-success?order=${order.id}`,
        cancel_url: `${FRONTEND_URL}/payment-cancelled?order=${order.id}`,
        metadata,
      });
    } else if (flow === "bacs_payment") {
      session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer: stripeCustomerId,
        payment_method_types: ["bacs_debit"],
        line_items: [
          {
            price_data: {
              currency: "gbp",
              product_data: { name: `${type} — ${order.title} (Direct Debit)` },
              unit_amount: Math.round(amount * 100),
            },
            quantity: 1,
          },
        ],
        success_url: `${FRONTEND_URL}/payment-success?order=${order.id}`,
        cancel_url: `${FRONTEND_URL}/payment-cancelled?order=${order.id}`,
        metadata,
      });
    } else {
      session = await stripe.checkout.sessions.create({
        mode: "setup",
        customer: stripeCustomerId,
        payment_method_types: ["bacs_debit"],
        success_url: `${FRONTEND_URL}/payment-success?setup=1&order=${order.id}`,
        cancel_url: `${FRONTEND_URL}/payment-cancelled?setup=1&order=${order.id}`,
        metadata,
      });
    }

    await sendEmail({
      to: order.email,
      subject:
        flow === "bacs_setup"
          ? `Setup your Direct Debit — ${order.title}`
          : `Secure ${type} payment — ${order.title}`,
      html: paymentRequestTemplate({
        customerName: order.name,
        orderTitle: order.title,
        amount: flow === "bacs_setup" ? 0 : amount,
        link: session.url,
        type,
      }),
    });

    res.json({ success: true, url: session.url });
  } catch (err) {
    console.error("❌ create-checkout error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   🔁 Webhook
============================================================ */
router.post("/webhook", async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("⚠️ Webhook signature failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const data = event.data.object;

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = data;
        if (session.mode === "setup") {
          const si = await stripe.setupIntents.retrieve(session.setup_intent);
          const pm = await stripe.paymentMethods.retrieve(si.payment_method);
          const mandate = pm.bacs_debit?.mandate || si.mandate;
          await pool.query(
            "UPDATE customers SET stripe_mandate_id=$1, direct_debit_active=true WHERE stripe_customer_id=$2",
            [mandate, session.customer]
          );
          console.log("✅ Bacs mandate stored.");
        }
        break;
      }

      case "payment_intent.succeeded":
        console.log("💰 Payment succeeded:", data.id);
        break;

      case "payment_intent.payment_failed":
        console.log("⚠️ Payment failed:", data.id);
        break;
    }

    res.json({ received: true });
  } catch (err) {
    console.error("❌ Webhook error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   🔁 Monthly Recurring Billing (Direct Debit)
============================================================ */
router.post("/bill-recurring", async (req, res) => {
  try {
    const { amount, description } = req.body;
    const { rows } = await pool.query(
      "SELECT * FROM customers WHERE direct_debit_active=true AND stripe_mandate_id IS NOT NULL"
    );

    for (const c of rows) {
      try {
        const pi = await stripe.paymentIntents.create({
          amount: Math.round(amount * 100),
          currency: "gbp",
          customer: c.stripe_customer_id,
          payment_method_types: ["bacs_debit"],
          payment_method_options: {
            bacs_debit: { mandate: c.stripe_mandate_id },
          },
          confirm: true,
          off_session: true,
          description: description || "PJH Monthly Maintenance",
        });

        console.log(`✅ Charged ${c.name}: £${amount}`);
        await sendEmail({
          to: c.email,
          subject: `Direct Debit payment successful — £${amount}`,
          html: paymentSuccessTemplate({ customerName: c.name, amount }),
        });
      } catch (e) {
        console.error(`❌ Failed for ${c.name}: ${e.message}`);
        await sendEmail({
          to: c.email,
          subject: "Payment failed — please update your details",
          html: paymentFailureTemplate({ customerName: c.name, amount }),
        });
      }
    }

    res.json({ success: true, message: "Billing run complete." });
  } catch (err) {
    console.error("❌ Billing error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
