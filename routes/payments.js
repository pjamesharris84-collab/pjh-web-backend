/**
 * ============================================================
 * PJH Web Services — Stripe Payments & Billing (Unified 2025)
 * ============================================================
 * Handles:
 *  ✅ Card & Bacs one-off payments
 *  ✅ Direct Debit setup (mode: "setup")
 *  ✅ Webhook-based reconciliation
 *  ✅ Refund endpoint (uses same table as orders)
 *  ✅ Correct netting so refunds allow re-charging
 * ============================================================
 */

import express from "express";
import Stripe from "stripe";
import dotenv from "dotenv";
import pool from "../db.js";
import bodyParser from "body-parser";
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

/* ============================================================
   💳 POST /api/payments/create-checkout
   Creates Stripe Checkout for deposit, balance, or DD setup
============================================================ */
router.post("/create-checkout", async (req, res) => {
  try {
    const { orderId, flow, type } = req.body;
    if (!orderId || !type) {
      return res
        .status(400)
        .json({ success: false, error: "Missing orderId or type" });
    }

    // 1️⃣ Fetch order + customer
    const { rows } = await pool.query(
      `
      SELECT 
        o.id, o.title, o.deposit, o.balance, o.customer_id,
        c.name AS customer_name, c.email,
        c.stripe_customer_id, c.stripe_mandate_id, c.direct_debit_active
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      WHERE o.id = $1;
      `,
      [orderId]
    );

    if (!rows.length) {
      return res
        .status(404)
        .json({ success: false, error: "Order not found" });
    }

    const order = rows[0];

    // 2️⃣ Determine base amount strictly from DB (or explicit override)
    const baseAmount =
      req.body.amount ??
      (type === "deposit" ? Number(order.deposit || 0) : Number(order.balance || 0));

    // 3️⃣ Net paid/ refunded for this order & type (refunds reduce net paid)
    const { rows: paymentSummary } = await pool.query(
      `
      SELECT
        COALESCE(SUM(CASE WHEN status='paid' THEN amount ELSE 0 END),0)::numeric AS paid_total,
        COALESCE(SUM(CASE WHEN status='refunded' THEN amount ELSE 0 END),0)::numeric AS refunded_total
      FROM payments
      WHERE order_id = $1
        AND (type = $2 OR type = 'refund');
      `,
      [order.id, type]
    );

    const paidTotal = Number(paymentSummary[0]?.paid_total || 0);
    const refundedTotal = Math.abs(Number(paymentSummary[0]?.refunded_total || 0));
    const netPaid = Math.max(paidTotal - refundedTotal, 0);

    // 4️⃣ Outstanding = baseAmount - netPaid (never negative)
    const amount = Math.max(baseAmount - netPaid, 0);

    console.log("🧾 create-checkout:", {
      orderId,
      type,
      flow,
      baseAmount,
      paidTotal,
      refundedTotal,
      netPaid,
      amount,
    });

    if (amount <= 0) {
      return res.status(400).json({
        success: false,
        error: `No outstanding ${type} amount — already paid or fully refunded.`,
      });
    }

    // 5️⃣ Ensure Stripe customer exists
    const stripeCustomer =
      order.stripe_customer_id ||
      (await stripe.customers
        .create({
          name: order.customer_name,
          email: order.email,
          metadata: { order_id: orderId },
        })
        .then((c) => {
          pool
            .query("UPDATE customers SET stripe_customer_id=$1 WHERE id=$2", [
              c.id,
              order.customer_id,
            ])
            .catch(() => {});
          return c.id;
        }));

    // 6️⃣ Decide mode & methods
    const mode =
      flow === "bacs_setup" ? "setup" : "payment";

    const payment_method_types =
      flow === "bacs_payment" || flow === "bacs_setup" ? ["bacs_debit"] : ["card"];

    // 7️⃣ Create Checkout Session
const session = await stripe.checkout.sessions.create({
  mode,
  customer: stripeCustomer,
  payment_method_types: paymentTypes,
  ...(mode === "setup"
    ? {}
    : {
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
      }),
  success_url: `${FRONTEND_URL}/payment-success?order=${order.id}`,
  cancel_url: `${FRONTEND_URL}/payment-cancelled?order=${order.id}`,
  metadata: { order_id: String(order.id), payment_type: type },
});


    // 8️⃣ Email the link to customer
    await sendEmail({
      to: order.email,
      subject: `Secure ${type} payment — ${order.title}`,
      html: paymentRequestTemplate({
        customerName: order.customer_name,
        orderTitle: order.title,
        amount,
        link: session.url,
        type,
      }),
    });

    console.log(
      `💳 Stripe checkout created for Order #${order.id} (${type}) — £${amount.toFixed(2)}`
    );

    return res.json({ success: true, url: session.url });
  } catch (err) {
    console.error("❌ create-checkout error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* ============================================================
   💸 POST /api/payments/refund
   Creates Stripe refund + records in DB
============================================================ */
router.post("/refund", async (req, res) => {
  const { payment_id, amount } = req.body;
  if (!payment_id || !amount) {
    return res
      .status(400)
      .json({ success: false, error: "Missing payment_id or amount." });
  }

  try {
    const { rows } = await pool.query(
      "SELECT * FROM payments WHERE id=$1 LIMIT 1",
      [payment_id]
    );
    if (!rows.length) {
      return res
        .status(404)
        .json({ success: false, error: "Payment not found." });
    }

    const payment = rows[0];
    const orderId = payment.order_id;

    if (!payment.reference) {
      return res
        .status(400)
        .json({ success: false, error: "Payment has no Stripe reference." });
    }

    const refund = await stripe.refunds.create({
      payment_intent: payment.reference,
      amount: Math.round(Number(amount) * 100),
      reason: "requested_by_customer",
    });

    await pool.query(
      `
      INSERT INTO payments (order_id, customer_id, amount, type, method, status, reference)
      VALUES ($1,$2,$3,'refund',$4,'refunded',$5);
      `,
      [orderId, payment.customer_id, -Math.abs(Number(amount)), payment.method, refund.id]
    );

    console.log(`💸 Refund recorded for order ${orderId} (£${Number(amount).toFixed(2)})`);
    return res.json({ success: true, message: "Refund processed successfully." });
  } catch (err) {
    console.error("❌ Refund error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* ============================================================
   ⚡ POST /api/payments/webhook — Stripe → backend
   NOTE: This route MUST receive the raw body (no JSON parsing)
============================================================ */
router.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body, // raw buffer
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("❌ Webhook signature failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object;
          const orderId = session.metadata?.order_id;
          const paymentType = session.metadata?.payment_type || "deposit";
          const method = (session.payment_method_types && session.payment_method_types[0]) || "card";
          const status = session.payment_status === "paid" ? "paid" : "pending";
          const amount =
            typeof session.amount_total === "number"
              ? session.amount_total / 100
              : 0;

          if (orderId && amount > 0) {
            await pool.query(
              `
              INSERT INTO payments (order_id, customer_id, amount, type, method, status, reference)
              SELECT id, customer_id, $1, $2, $3, $4, $5
              FROM orders
              WHERE id=$6;
              `,
              [amount, paymentType, method, status, session.payment_intent, orderId]
            );

            console.log(`💰 Payment recorded: Order #${orderId} — £${amount.toFixed(2)} [${paymentType}]`);
          }
          break;
        }

        case "setup_intent.succeeded": {
          const setup = event.data.object;
          const customer = setup.customer;
          const mandate = setup.mandate;

          await pool.query(
            "UPDATE customers SET stripe_mandate_id=$1, direct_debit_active=true WHERE stripe_customer_id=$2;",
            [mandate, customer]
          );

          console.log(`🏦 Direct Debit setup complete for customer ${customer}`);
          break;
        }

        default:
          console.log(`ℹ️ Unhandled event type: ${event.type}`);
      }

      return res.json({ received: true });
    } catch (err) {
      console.error("❌ Webhook handler error:", err);
      return res.status(500).send("Webhook handler error");
    }
  }
);

export default router;
