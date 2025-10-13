/**
 * ============================================================
 * PJH Web Services — Stripe Payments (Unified 2025)
 * ============================================================
 * ✅ Card & Bacs one-off payments
 * ✅ Direct Debit setup (mode: "setup")
 * ✅ Webhook reconciliation (raw-body safe)
 * ✅ Refund endpoint (recharge-friendly)
 * ✅ Payments summary endpoint for Admin UI
 * ✅ Stores payment_method_id for automation runs
 * ============================================================
 */

import express from "express";
import Stripe from "stripe";
import dotenv from "dotenv";
import pool from "../db.js";
import bodyParser from "body-parser";
import { sendEmail } from "../utils/email.js";
import { paymentRequestTemplate } from "../utils/emailTemplates.js";

dotenv.config();
const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const FRONTEND_URL =
  process.env.FRONTEND_URL ||
  (process.env.NODE_ENV === "development"
    ? "http://localhost:5173"
    : "https://www.pjhwebservices.co.uk");

/* ============================================================
   Helpers
============================================================ */
function toNum(v, f = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : f;
}

/* ============================================================
   📊 GET /api/payments/summary/:orderId
============================================================ */
router.get("/summary/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;
    const { rows } = await pool.query(
      `SELECT o.id, o.deposit, o.balance, o.total_paid, o.refunded_total, o.maintenance_id,
              c.direct_debit_active, c.stripe_mandate_id
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       WHERE o.id=$1`,
      [orderId]
    );

    if (!rows.length)
      return res.status(404).json({ success: false, message: "Order not found" });

    const o = rows[0];
    const { rows: mRows } = await pool.query(
      "SELECT price FROM maintenance_plans WHERE id=$1",
      [o.maintenance_id]
    );
    const maintenanceMonthly = Number(mRows?.[0]?.price || 0);

    // Financials
    const deposit = toNum(o.deposit);
    const balance = toNum(o.balance);
    const paid = toNum(o.total_paid);
    const refunded = Math.abs(toNum(o.refunded_total));
    const total = deposit + balance;
    const netPaid = paid - refunded;
    const remaining = Math.max(total - netPaid, 0);

    const deposit_outstanding = Math.max(deposit - netPaid, 0);
    const balance_outstanding = Math.max(remaining - deposit_outstanding, 0);

    res.json({
      success: true,
      data: {
        order_id: o.id,
        deposit_outstanding,
        balance_outstanding,
        maintenance_monthly: maintenanceMonthly,
        direct_debit_active: !!o.direct_debit_active,
        mandate_id: o.stripe_mandate_id || null,
      },
    });
  } catch (err) {
    console.error("❌ payments summary error:", err);
    res.status(500).json({ success: false, message: "Failed to build payment summary" });
  }
});

/* ============================================================
   💳 POST /api/payments/create-checkout
============================================================ */
router.post("/create-checkout", async (req, res) => {
  try {
    const { orderId, flow, type, amount: reqAmount } = req.body;
    if (!orderId) return res.status(400).json({ error: "Missing orderId" });

    const { rows } = await pool.query(
      `SELECT o.*, c.name AS customer_name, c.email, c.stripe_customer_id
       FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.id=$1`,
      [orderId]
    );
    if (!rows.length) return res.status(404).json({ error: "Order not found" });
    const order = rows[0];

    const baseAmount =
      reqAmount ?? (type === "deposit" ? toNum(order.deposit) : toNum(order.balance));

    // Outstanding check
    const { rows: paidRows } = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN status='paid' THEN amount ELSE 0 END),0) AS paid,
         COALESCE(SUM(CASE WHEN status='refunded' THEN amount ELSE 0 END),0) AS refunded
       FROM payments WHERE order_id=$1 AND type=$2`,
      [order.id, type || "deposit"]
    );
    const netPaid =
      Math.max(toNum(paidRows[0]?.paid) - Math.abs(toNum(paidRows[0]?.refunded)), 0);
    const amount = Math.max(baseAmount - netPaid, 0);
    if (flow !== "bacs_setup" && amount <= 0)
      return res.status(400).json({ error: `No outstanding ${type} amount.` });

    // Ensure Stripe customer
    let stripeCustomer = order.stripe_customer_id;
    if (!stripeCustomer) {
      const c = await stripe.customers.create({
        name: order.customer_name,
        email: order.email,
        metadata: { order_id: orderId },
      });
      stripeCustomer = c.id;
      await pool.query("UPDATE customers SET stripe_customer_id=$1 WHERE id=$2", [
        c.id,
        order.customer_id,
      ]);
    }

    const mode = flow === "bacs_setup" ? "setup" : "payment";
    const paymentMethodTypes =
      flow === "bacs_payment" || flow === "bacs_setup" ? ["bacs_debit"] : ["card"];

    const session = await stripe.checkout.sessions.create({
      mode,
      customer: stripeCustomer,
      payment_method_types: paymentMethodTypes,
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
      metadata: {
        order_id: String(order.id),
        payment_type: type || "setup",
      },
    });

    await sendEmail({
      to: order.email,
      subject: `Secure ${type || "Direct Debit"} payment — ${order.title}`,
      html: paymentRequestTemplate({
        customerName: order.customer_name,
        orderTitle: order.title,
        amount: mode === "setup" ? 0 : amount,
        link: session.url,
        type: type || "setup",
      }),
    });

    console.log(`✅ Stripe session created for order #${order.id} (${flow})`);
    res.json({ success: true, url: session.url, amount });
  } catch (err) {
    console.error("❌ create-checkout error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   💸 POST /api/payments/refund
============================================================ */
router.post("/refund", async (req, res) => {
  const { payment_id, amount } = req.body;
  if (!payment_id || !amount)
    return res.status(400).json({ error: "Missing payment_id or amount" });

  try {
    const { rows } = await pool.query("SELECT * FROM payments WHERE id=$1", [payment_id]);
    if (!rows.length) return res.status(404).json({ error: "Payment not found" });
    const p = rows[0];
    if (!p.reference)
      return res.status(400).json({ error: "No Stripe reference on payment." });

    const refund = await stripe.refunds.create({
      payment_intent: p.reference,
      amount: Math.round(Math.abs(Number(amount)) * 100),
      reason: "requested_by_customer",
    });

    await pool.query(
      `INSERT INTO payments (order_id, customer_id, amount, type, method, status, reference)
       VALUES ($1,$2,$3,'refund',$4,'refunded',$5)`,
      [p.order_id, p.customer_id, -Math.abs(Number(amount)), p.method || "card", refund.id]
    );

    console.log(`💸 Refund recorded for order ${p.order_id} (£${Number(amount).toFixed(2)})`);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Refund error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   ⚡ POST /api/payments/webhook
============================================================ */
router.post("/webhook", bodyParser.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("❌ Webhook signature failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object;
        const orderId = s.metadata?.order_id;
        const paymentType = s.metadata?.payment_type || "deposit";
        const method = s.payment_method_types?.[0] || "card";
        const amount = (s.amount_total ?? 0) / 100;
        if (orderId && amount > 0) {
          await pool.query(
            `INSERT INTO payments (order_id, customer_id, amount, type, method, status, reference)
             SELECT id, customer_id, $1, $2, $3, 'paid', $4 FROM orders WHERE id=$5`,
            [amount, paymentType, method, s.payment_intent, orderId]
          );
          console.log(`💰 Payment logged: order #${orderId} £${amount}`);
        }
        break;
      }

      case "setup_intent.succeeded": {
        const si = event.data.object;
        await pool.query(
          `UPDATE customers 
           SET stripe_mandate_id=$1, stripe_payment_method_id=$2, direct_debit_active=true 
           WHERE stripe_customer_id=$3`,
          [si.mandate, si.payment_method, si.customer]
        );
        console.log(`🏦 Direct Debit setup complete for ${si.customer}`);
        break;
      }

      case "payment_intent.succeeded": {
        const pi = event.data.object;
        const orderId = pi.metadata?.order_id;
        const amount = (pi.amount_received || pi.amount || 0) / 100;
        if (orderId && amount > 0) {
          await pool.query(
            `INSERT INTO payments (order_id, customer_id, amount, type, method, status, reference)
             SELECT id, customer_id, $1, 'maintenance', 'bacs', 'paid', $2 FROM orders WHERE id=$3`,
            [amount, pi.id, orderId]
          );
          console.log(`🏁 Bacs Debit paid: Order #${orderId} — £${amount}`);
        }
        break;
      }

      case "payment_intent.payment_failed": {
        const pi = event.data.object;
        await pool.query("UPDATE payments SET status='failed' WHERE reference=$1", [pi.id]);
        console.log(`❌ Bacs Debit failed: ${pi.id}`);
        break;
      }

      default:
        console.log(`ℹ️ Unhandled event: ${event.type}`);
    }

    res.json({ received: true });
  } catch (err) {
    console.error("❌ Webhook handler error:", err);
    res.status(500).send("Webhook handler error");
  }
});

export default router;
