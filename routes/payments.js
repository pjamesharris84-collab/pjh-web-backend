/**
 * ============================================================
 * PJH Web Services — Stripe Payments & Billing (Unified)
 * ============================================================
 * Supports:
 *  ✅ Card & Bacs one-off payments via Checkout
 *  ✅ Direct Debit mandate setup via Checkout (mode: "setup")
 *  ✅ Dynamic amounts (deposit/balance minus amounts already paid)
 *  ✅ Webhook-led reconciliation (payments table + orders.total_paid)
 *  ✅ Off-session monthly billing using stored Bacs mandates
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

// ✅ Let Stripe use the account’s default API version (don’t pin here)
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ------------------------------------------------------------
// Small helper: sum of paid payments for an order by type
// ------------------------------------------------------------
async function getAlreadyPaid(orderId, type) {
  const { rows } = await pool.query(
    `
    SELECT COALESCE(SUM(amount),0)::numeric AS paid
    FROM payments
    WHERE order_id = $1
      AND status = 'paid'
      AND ($2::text IS NULL OR type = $2)
  `,
    [orderId, type || null]
  );
  return Number(rows[0]?.paid || 0);
}

// ------------------------------------------------------------
// Ensure Stripe Customer exists (stores ID on customers table)
// ------------------------------------------------------------
async function ensureStripeCustomer(customer) {
  if (customer.stripe_customer_id) return customer.stripe_customer_id;

  const sc = await stripe.customers.create({
    name: customer.name || customer.business || "PJH Customer",
    email: customer.email,
    address: {
      line1: customer.address1 || "Address not provided",
      city: customer.city || "London",
      country: "GB",
      postal_code: customer.postcode || "EC1A 1AA",
    },
    metadata: { pjh_customer_id: customer.id },
  });

  await pool.query(
    `UPDATE customers SET stripe_customer_id = $1 WHERE id = $2`,
    [sc.id, customer.id]
  );
  return sc.id;
}

const FRONTEND_URL =
  process.env.FRONTEND_URL ||
  (process.env.NODE_ENV === "development"
    ? "http://localhost:5173"
    : "https://www.pjhwebservices.co.uk");

/* ============================================================
   💳 Create Checkout (Card / Bacs / Setup)
   Body: { orderId, flow: "card_payment"|"bacs_payment"|"bacs_setup", type?: "deposit"|"balance" }
============================================================ */
router.post("/create-checkout", async (req, res) => {
  try {
    const { orderId, flow, type } = req.body;

    if (!orderId) return res.status(400).json({ success: false, error: "Missing orderId." });
    if (!["card_payment", "bacs_payment", "bacs_setup"].includes(flow)) {
      return res.status(400).json({ success: false, error: "Invalid flow." });
    }
    if ((flow === "card_payment" || flow === "bacs_payment") && !["deposit", "balance"].includes(type)) {
      return res.status(400).json({ success: false, error: "Missing or invalid type for payment." });
    }

    // Load order + customer
    const { rows } = await pool.query(
      `
      SELECT
        o.*,
        c.id   AS cid,
        c.name AS customer_name,
        c.email,
        c.stripe_customer_id,
        c.stripe_mandate_id,
        c.direct_debit_active
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      WHERE o.id = $1
    `,
      [orderId]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: "Order not found." });
    const order = rows[0];

    // Ensure Stripe customer
    const stripeCustomerId = await ensureStripeCustomer({
      id: order.customer_id,
      name: order.customer_name,
      email: order.email,
      stripe_customer_id: order.stripe_customer_id,
      address1: order.address1,
      city: order.city,
      postcode: order.postcode,
      business: order.business,
    });

    // 🧮 Determine amount dynamically (remaining deposit/balance)
    let amount = 0;
    let lineName = "Setup Direct Debit";
    if (flow !== "bacs_setup") {
      const originalAmount = type === "deposit" ? Number(order.deposit) : Number(order.balance);
      const alreadyPaid = await getAlreadyPaid(order.id, type);
      amount = Math.max(originalAmount - alreadyPaid, 0);

      if (!amount) {
        return res.status(400).json({
          success: false,
          error: `No outstanding ${type} amount (already settled).`,
        });
      }
      lineName = `${type === "deposit" ? "Deposit" : "Balance"} — ${order.title}`;
    }

    const metadata = {
      order_id: String(order.id),
      customer_id: String(order.customer_id),
      payment_type: flow === "bacs_setup" ? "setup" : type,
    };

    // 🧾 Build a Checkout Session
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
              product_data: { name: lineName },
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
              product_data: { name: `${lineName} (Direct Debit)` },
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
      // Direct Debit mandate setup only (no charge)
      session = await stripe.checkout.sessions.create({
        mode: "setup",
        customer: stripeCustomerId,
        payment_method_types: ["bacs_debit"],
        success_url: `${FRONTEND_URL}/payment-success?setup=1&order=${order.id}`,
        cancel_url: `${FRONTEND_URL}/payment-cancelled?setup=1&order=${order.id}`,
        metadata,
      });
    }

    // 💌 Email payment/setup link to customer
    await sendEmail({
      to: order.email,
      subject:
        flow === "bacs_setup"
          ? `Setup your Direct Debit — ${order.title}`
          : `Secure ${type} payment — ${order.title}`,
      html: paymentRequestTemplate({
        customerName: order.customer_name,
        orderTitle: order.title,
        amount: flow === "bacs_setup" ? 0 : amount,
        link: session.url,
        type: flow === "bacs_setup" ? "setup" : type,
      }),
    });

    return res.json({ success: true, url: session.url });
  } catch (err) {
    console.error("❌ create-checkout error:", err);
    return res.status(500).json({ success: false, error: err.message || "Failed to create session." });
  }
});

/* ============================================================
   🔁 Webhook — expose as a handler that MUST be mounted with raw body
   Usage in server:
     app.post("/api/payments/webhook", express.raw({ type: "application/json" }), paymentsWebhook)
============================================================ */
export async function paymentsWebhook(req, res) {
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
      // ✅ Checkout completed (covers both mode: payment and mode: setup)
      case "checkout.session.completed": {
        const session = data;

        // If this was a setup session, persist mandate on the customer
        if (session.mode === "setup") {
          const si = await stripe.setupIntents.retrieve(session.setup_intent);
          let mandateId = si.mandate || null;

          // Some accounts store mandate on the payment method
          if (!mandateId && si.payment_method) {
            const pm = await stripe.paymentMethods.retrieve(si.payment_method);
            mandateId = pm?.bacs_debit?.mandate || null;
          }

          if (mandateId) {
            await pool.query(
              `
              UPDATE customers
              SET stripe_mandate_id = $1, direct_debit_active = TRUE
              WHERE stripe_customer_id = $2
            `,
              [mandateId, session.customer]
            );
            console.log(`✅ Stored Bacs mandate ${mandateId} for ${session.customer}`);
          }
        }

        // If this was a payment session, record payment now too (belts & braces)
        if (session.mode === "payment") {
          const amount = Number(session.amount_total || 0) / 100;
          const orderId = Number(session.metadata?.order_id || 0) || null;
          const customerId = Number(session.metadata?.customer_id || 0) || null;
          const paymentType = session.metadata?.payment_type || "card";
          const method = (session.payment_method_types || [])[0] || "card";

          if (orderId && amount > 0) {
            await pool.query(
              `
              INSERT INTO payments (stripe_event_id, order_id, customer_id, amount, type, method, reference, stripe_status, status)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'paid')
              ON CONFLICT (stripe_event_id) DO NOTHING
            `,
              [
                event.id,
                orderId,
                customerId,
                amount,
                paymentType,
                method,
                session.payment_intent || session.id,
                session.payment_status || "paid",
              ]
            );

            await pool.query(
              `UPDATE orders SET total_paid = COALESCE(total_paid,0) + $1 WHERE id = $2`,
              [amount, orderId]
            );

            console.log(`💰 Recorded payment £${amount} for order ${orderId}`);
          }
        }
        break;
      }

      // ✅ PaymentIntent-level success (covers alternate routes)
      case "payment_intent.succeeded": {
        const pi = data;
        const orderId = Number(pi.metadata?.order_id || 0) || null;
        const customerId = Number(pi.metadata?.customer_id || 0) || null;
        const amount = Number(pi.amount_received || 0) / 100;
        const paymentType = pi.metadata?.payment_type || "card";
        const method = (pi.payment_method_types || [])[0] || "card";

        if (orderId && amount > 0) {
          await pool.query(
            `
            INSERT INTO payments (stripe_event_id, order_id, customer_id, amount, type, method, reference, stripe_status, status)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'paid')
            ON CONFLICT (stripe_event_id) DO NOTHING
          `,
            [event.id, orderId, customerId, amount, paymentType, method, pi.id, pi.status]
          );

          await pool.query(
            `UPDATE orders SET total_paid = COALESCE(total_paid,0) + $1 WHERE id = $2`,
            [amount, orderId]
          );

          console.log(`💰 Recorded PI payment £${amount} for order ${orderId}`);
        }
        break;
      }

      case "payment_intent.payment_failed": {
        const pi = data;
        const orderId = Number(pi.metadata?.order_id || 0) || null;
        const customerId = Number(pi.metadata?.customer_id || 0) || null;
        const amount = Number(pi.amount || 0) / 100;
        const paymentType = pi.metadata?.payment_type || "card";
        const method = (pi.payment_method_types || [])[0] || "card";

        await pool.query(
          `
          INSERT INTO payments (stripe_event_id, order_id, customer_id, amount, type, method, reference, stripe_status, status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'failed')
          ON CONFLICT (stripe_event_id) DO NOTHING
        `,
          [event.id, orderId, customerId, amount, paymentType, method, pi.id, pi.status]
        );

        if (customerId) {
          const cust = await pool.query(`SELECT name, email FROM customers WHERE id=$1`, [customerId]);
          const c = cust.rows[0];
          if (c?.email) {
            await sendEmail({
              to: c.email,
              subject: "Payment failed — action required",
              html: paymentFailureTemplate({ customerName: c.name || "Customer", amount }),
            });
          }
        }

        console.warn(`⚠️ Payment failed for order ${orderId || "unknown"} (${pi.id})`);
        break;
      }

      case "charge.refunded":
      case "payment_intent.canceled": {
        const ref = data.id || data.payment_intent || null;
        await pool.query(
          `UPDATE payments SET status='refunded', stripe_status=$2 WHERE reference=$1`,
          [ref, data.status]
        );
        console.log(`↩️ Refunded/cancelled: ${ref}`);
        break;
      }

      default:
        // Useful during early integration
        console.log(`ℹ️ Unhandled Stripe event: ${event.type}`);
    }

    return res.json({ received: true });
  } catch (err) {
    console.error("❌ Webhook processing error:", err);
    return res.status(500).json({ success: false });
  }
}

/* ============================================================
   🔁 Monthly Recurring Billing (Direct Debit off-session)
   Body: { amount, description? }
============================================================ */
router.post("/bill-recurring", async (req, res) => {
  try {
    const { amount, description } = req.body;
    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ success: false, error: "Missing/invalid amount." });
    }

    const { rows } = await pool.query(
      `
      SELECT id, name, email, stripe_customer_id, stripe_mandate_id
      FROM customers
      WHERE direct_debit_active = TRUE
        AND stripe_customer_id IS NOT NULL
        AND stripe_mandate_id IS NOT NULL
    `
    );

    for (const c of rows) {
      try {
        const pi = await stripe.paymentIntents.create({
          amount: Math.round(Number(amount) * 100),
          currency: "gbp",
          customer: c.stripe_customer_id,
          payment_method_types: ["bacs_debit"],
          payment_method_options: {
            bacs_debit: { mandate: c.stripe_mandate_id },
          },
          confirm: true,
          off_session: true,
          description: description || "PJH Monthly Maintenance",
          metadata: { customer_id: String(c.id), payment_type: "monthly" },
        });

        console.log(`✅ Charged ${c.name}: £${Number(amount).toFixed(2)} (PI ${pi.id})`);

        await sendEmail({
          to: c.email,
          subject: `Direct Debit payment successful — £${Number(amount).toFixed(2)}`,
          html: paymentSuccessTemplate({ customerName: c.name, amount: Number(amount) }),
        });
      } catch (e) {
        console.error(`❌ Failed for ${c.name}: ${e.message}`);
        await sendEmail({
          to: c.email,
          subject: "Payment failed — please update your details",
          html: paymentFailureTemplate({ customerName: c.name, amount: Number(amount) }),
        });
      }
    }

    return res.json({ success: true, message: "Billing run complete." });
  } catch (err) {
    console.error("❌ Billing error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
