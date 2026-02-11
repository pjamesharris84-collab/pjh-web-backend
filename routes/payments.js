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
   💳 GET /api/orders/:id/payments — Unified payment history
============================================================ */
router.get("/orders/:id/payments", async (req, res) => {
  const { id } = req.params;

  try {
    const { rows } = await pool.query(
      `
      SELECT 
        p.id,
        p.order_id,
        p.amount,
        p.type,
        p.method,
        p.status,
        p.reference,
        p.created_at
      FROM payments p
      WHERE p.order_id = $1
      ORDER BY p.created_at DESC;
      `,
      [id]
    );

    res.json({ success: true, payments: rows });
  } catch (err) {
    console.error("❌ Error fetching payments:", err);
    res.status(500).json({ success: false, error: "Failed to load payments." });
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

/**
 * ============================================================
 * POST /api/payments/refund
 * ============================================================
 * Supports multiple charge IDs on one order.
 * - Finds first eligible (unrefunded) charge for refunding.
 * - Ensures cumulative refunds never exceed total paid.
 * - Logs each refund in payments table.
 * ============================================================
 */
router.post("/refund", async (req, res) => {
  try {
    const { order_id, amount, reason, notes } = req.body;

    if (!order_id || !amount)
      return res.status(400).json({ error: "Missing order_id or amount" });

    const refundAmount = Number(amount);
    if (!(refundAmount > 0))
      return res.status(400).json({ error: "Refund amount must be greater than zero." });

    // Fetch all paid charges for this order
    const { rows: charges } = await pool.query(
      `SELECT id, stripe_charge_id, amount
       FROM payments
       WHERE order_id = $1
         AND status = 'paid'
         AND type != 'refund'
         AND stripe_charge_id IS NOT NULL
       ORDER BY created_at ASC`,
      [order_id]
    );

    if (charges.length === 0)
      return res.status(404).json({ error: "No Stripe charges found for refund." });

    // Compute total paid vs total refunded
    const { rows: [totals] } = await pool.query(
      `SELECT 
         COALESCE(SUM(CASE WHEN type != 'refund' AND status='paid' THEN amount ELSE 0 END),0) AS total_paid,
         COALESCE(SUM(CASE WHEN type = 'refund' AND status='refunded' THEN amount ELSE 0 END),0) AS total_refunded
       FROM payments
       WHERE order_id = $1`,
      [order_id]
    );

    const totalPaid = Number(totals.total_paid || 0);
    const totalRefunded = Number(totals.total_refunded || 0);
    const remainingRefundable = totalPaid - totalRefunded;

    if (refundAmount > remainingRefundable) {
      return res.status(400).json({
        error: `Refund exceeds refundable balance (£${remainingRefundable.toFixed(2)}).`,
      });
    }

    // 🔍 Find a charge that can still be refunded
    let refundSuccess = false;
    let usedChargeId = null;
    let refund;

    for (const charge of charges) {
      try {
        const stripeCharge = await stripe.charges.retrieve(charge.stripe_charge_id);
        if (stripeCharge.refunded) {
          console.log(`⏭️ Skipping ${charge.stripe_charge_id} — already refunded`);
          continue;
        }

        refund = await stripe.refunds.create({
          charge: charge.stripe_charge_id,
          amount: Math.round(refundAmount * 100),
          reason: reason || "requested_by_customer",
        });

        usedChargeId = charge.stripe_charge_id;
        refundSuccess = true;
        console.log(`✅ Refunded ${refundAmount} from ${usedChargeId}`);
        break;
      } catch (err) {
        console.warn(`⚠️ Charge ${charge.stripe_charge_id} failed refund: ${err.message}`);
      }
    }

    if (!refundSuccess) {
      return res.status(400).json({
        error: "No eligible Stripe charges could be refunded.",
      });
    }

    // Log refund in DB
    await pool.query(
      `INSERT INTO payments
         (order_id, amount, type, method, stripe_refund_id, refund_reason, notes, source, status)
       VALUES ($1, $2, 'refund', 'stripe', $3, $4, $5, 'system', 'refunded')`,
      [order_id, refundAmount, refund.id, reason || "manual refund", notes || null]
    );

    res.json({
      success: true,
      message: `Refund of £${refundAmount.toFixed(2)} processed.`,
      refund_id: refund.id,
      used_charge_id: usedChargeId,
      remaining_refundable: remainingRefundable - refundAmount,
    });
  } catch (err) {
    console.error("❌ Refund error:", err);
    res.status(500).json({ error: err.message });
  }
});


/* ============================================================
   📊 GET /api/payments/summary/:orderId
   Returns full payment + direct debit metadata for Admin UI
============================================================ */
router.get("/summary/:orderId", async (req, res) => {
  const { orderId } = req.params;
  try {
    const { rows } = await pool.query(
      `
      SELECT 
        o.id AS order_id,
        o.customer_id,
        o.maintenance_name,
        o.maintenance_monthly,
        o.monthly_amount,
        c.direct_debit_active,
        c.stripe_customer_id,
        c.stripe_payment_method_id,
        c.stripe_mandate_id AS mandate_id,
        (
          SELECT COALESCE(SUM(amount),0) 
          FROM payments 
          WHERE order_id=o.id AND status='paid'
        ) AS total_paid
      FROM orders o
      JOIN customers c ON c.id=o.customer_id
      WHERE o.id=$1
      `,
      [orderId]
    );

    if (!rows.length)
      return res.status(404).json({ success: false, error: "Order not found" });

    const summary = rows[0];
    res.json({ success: true, data: summary });
  } catch (err) {
    console.error("❌ Error fetching payment summary:", err);
    res.status(500).json({ success: false, error: "Failed to load summary" });
  }
});


export default router;
