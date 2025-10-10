/**
 * ============================================================
 * PJH Web Services — Orders & Invoicing API (Unified 2025 Final)
 * ============================================================
 * Handles:
 *  ✅ Order lifecycle & quote conversion
 *  ✅ Stripe & manual payments
 *  ✅ Refund-aware total reconciliation
 *  ✅ Invoice generation + email delivery
 *  ✅ Dynamic totals (paid, refunded, balance)
 * ============================================================
 */

import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pool from "../db.js";
import dotenv from "dotenv";
import Stripe from "stripe";
import { sendEmail } from "../utils/email.js";
import { generateInvoicePDF } from "../utils/invoice.js";
import { invoiceEmailTemplate } from "../utils/emailTemplates.js";

dotenv.config();
const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const FRONTEND_URL =
  process.env.FRONTEND_URL ||
  (process.env.NODE_ENV === "development"
    ? "http://localhost:5173"
    : "https://www.pjhwebservices.co.uk");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ============================================================
   🧱 GET /api/orders
============================================================ */
router.get("/", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT 
        o.*, c.business AS customer_business, c.name AS customer_name,
        c.email AS customer_email, c.phone AS customer_phone
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      ORDER BY o.created_at DESC;
    `);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("❌ Error fetching orders:", err);
    res.status(500).json({ success: false, error: "Failed to fetch orders." });
  }
});

/* ============================================================
   🔍 GET /api/orders/:id (refund-aware totals)
============================================================ */
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `
      SELECT 
        o.*, c.business AS customer_business, c.name AS customer_name,
        c.email AS customer_email, c.phone AS customer_phone,
        c.address1, c.address2, c.city, c.county, c.postcode,
        c.direct_debit_active
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      WHERE o.id = $1;
      `,
      [id]
    );

    if (!rows.length)
      return res.status(404).json({ success: false, error: "Order not found." });

    const order = rows[0];

    const { rows: payments } = await pool.query(
      `
      SELECT id, order_id, customer_id, amount, type, method, status, reference, created_at
      FROM payments
      WHERE order_id=$1
      ORDER BY created_at ASC;
      `,
      [id]
    );

    // 💰 Totals including refunds
    const paid = payments
      .filter((p) => p.status === "paid" && p.amount > 0)
      .reduce((sum, p) => sum + Number(p.amount), 0);
    const refunded = payments
      .filter((p) => p.status === "refunded" || p.amount < 0)
      .reduce((sum, p) => sum + Math.abs(Number(p.amount)), 0);
    const netPaid = paid - refunded;
    const total = Number(order.deposit || 0) + Number(order.balance || 0);
    const balanceDue = Math.max(total - netPaid, 0);

    res.json({
      success: true,
      data: {
        ...order,
        payments,
        total_paid: netPaid,
        refunded_total: refunded,
        balance_due: balanceDue,
      },
    });
  } catch (err) {
    console.error("❌ Error fetching order:", err);
    res.status(500).json({ success: false, error: "Failed to fetch order." });
  }
});

/* ============================================================
   💰 GET /api/orders/:id/payments (includes refunds)
============================================================ */
router.get("/:id/payments", async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `
      SELECT id, order_id, customer_id, amount, type, method, status, reference, created_at
      FROM payments
      WHERE order_id=$1
      ORDER BY created_at DESC;
      `,
      [id]
    );
    res.json({ success: true, payments: rows });
  } catch (err) {
    console.error("❌ Error fetching payments:", err);
    res.status(500).json({ success: false, error: "Failed to fetch payments." });
  }
});

/* ============================================================
   💸 POST /api/payments/refund (Stripe + record in payments)
============================================================ */
router.post("/refund", async (req, res) => {
  const { payment_id, amount } = req.body;
  if (!payment_id || !amount)
    return res
      .status(400)
      .json({ success: false, error: "Missing payment_id or amount." });

  try {
    const { rows } = await pool.query("SELECT * FROM payments WHERE id=$1 LIMIT 1", [
      payment_id,
    ]);
    if (!rows.length)
      return res.status(404).json({ success: false, error: "Payment not found." });

    const payment = rows[0];
    const orderId = payment.order_id;

    if (!payment.reference)
      return res
        .status(400)
        .json({ success: false, error: "Payment has no Stripe reference." });

    const refund = await stripe.refunds.create({
      payment_intent: payment.reference,
      amount: Math.round(amount * 100),
      reason: "requested_by_customer",
    });

    await pool.query(
      `
      INSERT INTO payments (order_id, customer_id, amount, type, method, status, reference)
      VALUES ($1,$2,$3,'refund',$4,'refunded',$5);
      `,
      [orderId, payment.customer_id, -Math.abs(amount), payment.method, refund.id]
    );

    console.log(`💸 Refund processed for order ${orderId}: £${amount.toFixed(2)}`);
    res.json({ success: true, message: "Refund processed successfully." });
  } catch (err) {
    console.error("❌ Refund error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ============================================================
   🔁 GET /api/orders/:id/refresh (re-syncs totals)
============================================================ */
router.get("/:id/refresh", async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `
      SELECT o.*, c.business AS customer_business, c.name AS customer_name,
             c.email AS customer_email, c.phone AS customer_phone,
             c.direct_debit_active
      FROM orders o
      JOIN customers c ON o.customer_id=c.id
      WHERE o.id=$1;
      `,
      [id]
    );

    if (!rows.length)
      return res.status(404).json({ success: false, error: "Order not found." });

    const order = rows[0];
    const { rows: payments } = await pool.query(
      "SELECT * FROM payments WHERE order_id=$1 ORDER BY created_at DESC",
      [id]
    );

    const paid = payments
      .filter((p) => p.status === "paid" && p.amount > 0)
      .reduce((sum, p) => sum + Number(p.amount), 0);
    const refunded = payments
      .filter((p) => p.status === "refunded" || p.amount < 0)
      .reduce((sum, p) => sum + Math.abs(Number(p.amount)), 0);
    const netPaid = paid - refunded;

    res.json({
      success: true,
      data: { ...order, payments, total_paid: netPaid, refunded_total: refunded },
    });
  } catch (err) {
    console.error("❌ Error refreshing order:", err);
    res.status(500).json({ success: false, error: "Failed to refresh order." });
  }
});

export default router;
