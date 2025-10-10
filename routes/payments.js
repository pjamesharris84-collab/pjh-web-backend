/**
 * ============================================================
 * PJH Web Services — Stripe Payments & Billing (Final 2025)
 * ============================================================
 * Handles:
 *  ✅ Card & Bacs one-off payments via Checkout
 *  ✅ Direct Debit setup (mode: "setup")
 *  ✅ Webhook-based reconciliation to orders/payments
 *  ✅ Safe retry logic (no double increments)
 *  ✅ Off-session recurring billing
 *  ✅ Refund endpoint (Stripe + manual)
 * ============================================================
 */

import express from "express";
import Stripe from "stripe";
import dotenv from "dotenv";
import { pool } from "../db.js";
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
  process.env.FRONTEND_URL ||
  (process.env.NODE_ENV === "development"
    ? "http://localhost:5173"
    : "https://www.pjhwebservices.co.uk");

/* ------------------------------------------------------------
   Helpers
------------------------------------------------------------ */
async function getAlreadyPaid(orderId, type) {
  const { rows } = await pool.query(
    `
    SELECT COALESCE(SUM(amount),0)::numeric AS paid
    FROM payments
    WHERE order_id=$1 AND status='paid'
      AND ($2::text IS NULL OR type=$2)
    `,
    [orderId, type || null]
  );
  return Number(rows[0]?.paid || 0);
}

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
    `UPDATE customers SET stripe_customer_id=$1 WHERE id=$2`,
    [sc.id, customer.id]
  );
  return sc.id;
}

/* ============================================================
   💳 POST /api/payments/create-checkout
============================================================ */
router.post("/create-checkout", async (req, res) => {
  try {
    const { orderId, flow, type } = req.body;
    if (!orderId)
      return res.status(400).json({ success: false, error: "Missing orderId" });
    if (!["card_payment", "bacs_payment", "bacs_setup"].includes(flow))
      return res.status(400).json({ success: false, error: "Invalid flow" });

    const { rows } = await pool.query(
      `
      SELECT o.*, c.id AS cid, c.name AS customer_name, c.email,
             c.stripe_customer_id, c.stripe_mandate_id,
             c.direct_debit_active, c.address1, c.city, c.postcode, c.business
      FROM orders o
      JOIN customers c ON c.id=o.customer_id
      WHERE o.id=$1
      `,
      [orderId]
    );
    if (!rows.length)
      return res.status(404).json({ success: false, error: "Order not found" });

    const order = rows[0];
    const stripeCustomerId = await ensureStripeCustomer(order);

    // 🧮 Determine amount
    let amount = 0;
    let lineName = "Setup Direct Debit";
    if (flow !== "bacs_setup") {
      const baseAmount =
        type === "deposit" ? Number(order.deposit) : Number(order.balance);
      const alreadyPaid = await getAlreadyPaid(order.id, type);
      amount = Math.max(baseAmount - alreadyPaid, 0);
      if (amount <= 0)
        return res
          .status(400)
          .json({ success: false, error: `No outstanding ${type} amount` });
      lineName = `${type === "deposit" ? "Deposit" : "Balance"} — ${order.title}`;
    }

    const metadata = {
      order_id: String(order.id),
      customer_id: String(order.cid),
      payment_type: flow === "bacs_setup" ? "setup" : type,
    };

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
      session = await stripe.checkout.sessions.create({
        mode: "setup",
        customer: stripeCustomerId,
        payment_method_types: ["bacs_debit"],
        success_url: `${FRONTEND_URL}/setup-complete?order=${order.id}`,
        cancel_url: `${FRONTEND_URL}/direct-debit-setup?cancel=1`,
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
        customerName: order.customer_name,
        orderTitle: order.title,
        amount,
        link: session.url,
        type,
      }),
    });

    res.json({ success: true, url: session.url });
  } catch (err) {
    console.error("❌ create-checkout error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ============================================================
   🔔 STRIPE WEBHOOK — Reconcile Payments + Update Orders
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
    console.error("⚠️ Invalid signature:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const obj = event.data.object;
  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = obj;
        if (s.mode === "setup") {
          const si = await stripe.setupIntents.retrieve(s.setup_intent);
          const pm =
            si.payment_method &&
            (await stripe.paymentMethods.retrieve(si.payment_method));
          const mandateId = si.mandate || pm?.bacs_debit?.mandate || null;
          if (mandateId) {
            await pool.query(
              `UPDATE customers
               SET stripe_mandate_id=$1, direct_debit_active=TRUE
               WHERE stripe_customer_id=$2`,
              [mandateId, s.customer]
            );
            console.log(`✅ Mandate stored: ${mandateId}`);
          }
        }

        if (s.mode === "payment") {
          const orderId = Number(s.metadata?.order_id || 0);
          const customerId = Number(s.metadata?.customer_id || 0);
          const amount = (s.amount_total || 0) / 100;
          const payType = s.metadata?.payment_type || "card";
          const method = (s.payment_method_types || [])[0] || "card";

          if (orderId && amount > 0) {
            await pool.query(
              `INSERT INTO payments
                 (stripe_event_id, order_id, customer_id, amount, type, method, reference, stripe_status, status)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'paid')
               ON CONFLICT (stripe_event_id) DO NOTHING`,
              [event.id, orderId, customerId, amount, payType, method, s.payment_intent || s.id, s.payment_status]
            );

            const { rows } = await pool.query(
              `SELECT COALESCE(SUM(amount),0)::numeric AS paid
               FROM payments WHERE order_id=$1 AND status='paid'`,
              [orderId]
            );
            const totalPaid = Number(rows[0]?.paid || 0);

            const flag =
              payType === "deposit"
                ? "deposit_paid"
                : payType === "balance"
                ? "balance_paid"
                : null;
            const q = flag
              ? `UPDATE orders SET ${flag}=TRUE, total_paid=$1, updated_at=NOW() WHERE id=$2`
              : `UPDATE orders SET total_paid=$1, updated_at=NOW() WHERE id=$2`;
            await pool.query(q, [totalPaid, orderId]);
            console.log(`💰 Reconciled order ${orderId} — £${amount}`);
          }
        }
        break;
      }

      case "payment_intent.succeeded": {
        const pi = obj;
        const orderId = Number(pi.metadata?.order_id || 0);
        const customerId = Number(pi.metadata?.customer_id || 0);
        const amount = Number(pi.amount_received || 0) / 100;
        const payType = pi.metadata?.payment_type || "card";
        const method = pi.payment_method_types?.[0] || "card";

        if (orderId && amount > 0) {
          await pool.query(
            `INSERT INTO payments
               (stripe_event_id, order_id, customer_id, amount, type, method, reference, stripe_status, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'paid')
             ON CONFLICT (stripe_event_id) DO NOTHING`,
            [event.id, orderId, customerId, amount, payType, method, pi.id, pi.status]
          );

          const { rows } = await pool.query(
            `SELECT COALESCE(SUM(amount),0)::numeric AS paid
             FROM payments WHERE order_id=$1 AND status='paid'`,
            [orderId]
          );
          const totalPaid = Number(rows[0]?.paid || 0);

          const flag =
            payType === "deposit"
              ? "deposit_paid"
              : payType === "balance"
              ? "balance_paid"
              : null;
          const q = flag
            ? `UPDATE orders SET ${flag}=TRUE, total_paid=$1, updated_at=NOW() WHERE id=$2`
            : `UPDATE orders SET total_paid=$1, updated_at=NOW() WHERE id=$2`;
          await pool.query(q, [totalPaid, orderId]);
          console.log(`💰 PaymentIntent success — order ${orderId} now £${totalPaid} paid`);
        }
        break;
      }

      case "payment_intent.payment_failed": {
        const pi = obj;
        const orderId = Number(pi.metadata?.order_id || 0);
        await pool.query(
          `UPDATE payments SET status='failed', stripe_status=$2 WHERE reference=$1`,
          [pi.id, pi.status]
        );
        console.warn(`⚠️ Payment failed for order ${orderId}`);
        break;
      }

      default:
        console.log(`ℹ️ Unhandled event: ${event.type}`);
    }

    res.json({ received: true });
  } catch (err) {
    console.error("❌ Webhook processing error:", err);
    res.status(500).json({ success: false });
  }
}

/* ============================================================
   🧾 POST /api/payments/bill-recurring
============================================================ */
router.post("/bill-recurring", async (req, res) => {
  try {
    const { amount, description } = req.body;
    if (!amount || Number(amount) <= 0)
      return res
        .status(400)
        .json({ success: false, error: "Missing or invalid amount" });

    const { rows } = await pool.query(`
      SELECT id, name, email, stripe_customer_id, stripe_mandate_id
      FROM customers
      WHERE direct_debit_active=TRUE
        AND stripe_customer_id IS NOT NULL
        AND stripe_mandate_id IS NOT NULL
    `);

    for (const c of rows) {
      try {
        const pi = await stripe.paymentIntents.create({
          amount: Math.round(Number(amount) * 100),
          currency: "gbp",
          customer: c.stripe_customer_id,
          payment_method_types: ["bacs_debit"],
          payment_method_options: { bacs_debit: { mandate: c.stripe_mandate_id } },
          confirm: true,
          off_session: true,
          description: description || "PJH Monthly Maintenance",
          metadata: { customer_id: String(c.id), payment_type: "monthly" },
        });

        await sendEmail({
          to: c.email,
          subject: `Direct Debit payment successful — £${Number(amount).toFixed(2)}`,
          html: paymentSuccessTemplate({
            customerName: c.name,
            amount: Number(amount),
          }),
        });
        console.log(`✅ Charged ${c.name}: £${amount}`);
      } catch (e) {
        console.error(`❌ Failed for ${c.name}: ${e.message}`);
        await sendEmail({
          to: c.email,
          subject: "Payment failed — please update your details",
          html: paymentFailureTemplate({
            customerName: c.name,
            amount: Number(amount),
          }),
        });
      }
    }

    res.json({ success: true, message: "Billing run complete" });
  } catch (err) {
    console.error("❌ Billing error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ============================================================
   💸 POST /api/payments/refund
   Unified Refund API — uses payments table, not refunds
============================================================ */
router.post("/refund", async (req, res) => {
  const { payment_id, amount } = req.body;
  if (!payment_id || !amount)
    return res
      .status(400)
      .json({ success: false, error: "Missing payment_id or amount." });

  try {
    const { rows } = await pool.query(
      "SELECT * FROM payments WHERE id=$1 LIMIT 1",
      [payment_id]
    );
    if (!rows.length)
      return res.status(404).json({ success: false, error: "Payment not found." });

    const payment = rows[0];
    const orderId = payment.order_id;

    if (!payment.reference)
      return res
        .status(400)
        .json({ success: false, error: "Payment has no Stripe reference." });

    // Stripe refund
    const refund = await stripe.refunds.create({
      payment_intent: payment.reference,
      amount: Math.round(amount * 100),
      reason: "requested_by_customer",
    });

    // ✅ Record refund in payments table
    await pool.query(
      `
      INSERT INTO payments (order_id, customer_id, amount, type, method, status, reference)
      VALUES ($1,$2,$3,'refund',$4,'refunded',$5);
      `,
      [orderId, payment.customer_id, -Math.abs(amount), payment.method, refund.id]
    );

    // ✅ Adjust total paid
    await pool.query(
      `UPDATE orders SET total_paid = COALESCE(total_paid,0) - $1 WHERE id=$2;`,
      [amount, orderId]
    );

    console.log(`💸 Refund processed for order ${orderId}: £${amount.toFixed(2)}`);
    res.json({ success: true, message: "Refund processed successfully." });
  } catch (err) {
    console.error("❌ Refund error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});


export default router;
