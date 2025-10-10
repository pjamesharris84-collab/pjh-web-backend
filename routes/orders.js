/**
 * ============================================================
 * PJH Web Services — Orders & Invoicing API (2025 Final Stable)
 * ============================================================
 * Handles:
 *  ✅ Order lifecycle & quote conversion
 *  ✅ Stripe & manual payments
 *  ✅ Direct Debit integration
 *  ✅ Invoice PDF generation + email delivery
 *  ✅ Invoice PDF preview (GET)
 *  ✅ Dynamic invoice filenames (PJH-INV-<order>-<type>.pdf)
 *  ✅ Payment reconciliation, refresh & refunds
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
import {
  paymentRequestTemplate,
  invoiceEmailTemplate,
} from "../utils/emailTemplates.js";

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
        c.email AS customer_email, c.phone AS customer_phone,
        c.address1, c.address2, c.city, c.county, c.postcode
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
   🔍 GET /api/orders/:id
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
      "SELECT * FROM payments WHERE order_id=$1 ORDER BY created_at ASC",
      [id]
    );

    const totalPaid = payments
      .filter((p) => p.status === "paid")
      .reduce((sum, p) => sum + Number(p.amount), 0);

    res.json({
      success: true,
      data: {
        ...order,
        payments,
        total_paid: totalPaid,
        balance_due:
          Number(order.deposit || 0) +
          Number(order.balance || 0) -
          Number(totalPaid || 0),
      },
    });
  } catch (err) {
    console.error("❌ Error fetching order:", err);
    res.status(500).json({ success: false, error: "Failed to fetch order." });
  }
});

/* ============================================================
   💰 GET /api/orders/:id/payments
   (Fixes 404 on admin panel)
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
   💸 POST /api/payments/refund
   (Supports refund from AdminOrderRecord)
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

    // Create Stripe refund
    const refund = await stripe.refunds.create({
      payment_intent: payment.reference,
      amount: Math.round(amount * 100),
      reason: "requested_by_customer",
    });

    // Record in DB
    await pool.query(
      `
      INSERT INTO payments (order_id, customer_id, amount, type, method, status, reference)
      VALUES ($1,$2,$3,'refund',$4,'refunded',$5);
      `,
      [orderId, payment.customer_id, -Math.abs(amount), payment.method, refund.id]
    );

    await pool.query(
      `UPDATE orders SET total_paid = COALESCE(total_paid,0) - $1 WHERE id=$2;`,
      [amount, orderId]
    );

    res.json({ success: true, message: "Refund processed successfully." });
  } catch (err) {
    console.error("❌ Refund error:", err);
    res
      .status(500)
      .json({ success: false, error: "Failed to process refund." });
  }
});

/* ============================================================
   🪄 POST /api/orders/from-quote/:quoteId
============================================================ */
router.post("/from-quote/:quoteId", async (req, res) => {
  const { quoteId } = req.params;
  try {
    const existing = await pool.query(
      "SELECT * FROM orders WHERE quote_id=$1 LIMIT 1",
      [quoteId]
    );
    if (existing.rows.length)
      return res.json({
        success: true,
        message: "Order already exists for this quote.",
        data: existing.rows[0],
      });

    const quoteRes = await pool.query("SELECT * FROM quotes WHERE id=$1", [
      quoteId,
    ]);
    if (!quoteRes.rows.length)
      return res.status(404).json({ success: false, error: "Quote not found." });

    const quote = quoteRes.rows[0];
    const items = Array.isArray(quote.items)
      ? quote.items
      : JSON.parse(quote.items || "[]");

    const total = items.reduce(
      (sum, i) =>
        sum + Number(i.qty ?? 1) * Number(i.unit_price ?? i.price ?? 0),
      0
    );
    const deposit = Number(quote.deposit ?? total * 0.5);
    const balance = total - deposit;

    const { rows } = await pool.query(
      `
      INSERT INTO orders (
        customer_id, quote_id, title, description, status,
        items, deposit, balance, tasks, diary
      )
      VALUES ($1,$2,$3,$4,'in_progress',$5,$6,$7,'[]','[]')
      RETURNING *;
      `,
      [
        quote.customer_id,
        quote.id,
        quote.title,
        quote.description || "",
        JSON.stringify(items),
        deposit,
        balance,
      ]
    );

    res.json({
      success: true,
      message: "✅ Order created successfully from quote.",
      data: rows[0],
    });
  } catch (err) {
    console.error("❌ Error creating order:", err);
    res.status(500).json({ success: false, error: "Failed to create order." });
  }
});

/* ============================================================
   🧾 POST /api/orders/:id/invoice/:type (Generate + email)
============================================================ */
router.post("/:id/invoice/:type", async (req, res) => {
  const { id, type } = req.params;
  const invoiceType = type.toLowerCase();
  if (!["deposit", "balance"].includes(invoiceType))
    return res
      .status(400)
      .json({ success: false, error: "Invalid invoice type." });

  try {
    const { rows } = await pool.query(
      `SELECT o.*, c.* FROM orders o JOIN customers c ON o.customer_id = c.id WHERE o.id=$1;`,
      [id]
    );
    if (!rows.length)
      return res.status(404).json({ success: false, error: "Order not found." });

    const order = rows[0];
    const { rows: payments } = await pool.query(
      `SELECT * FROM payments WHERE order_id=$1 AND status='paid'`,
      [id]
    );

    const totalPaid = payments.reduce((sum, p) => sum + Number(p.amount), 0);
    const subtotal = Number(order.deposit || 0) + Number(order.balance || 0);
    const balanceDue = Math.max(subtotal - totalPaid, 0);

    const filename = `PJH-INV-${order.id}-${invoiceType}.pdf`;
    const pdfPath = await generateInvoicePDF(
      { ...order, total_paid: totalPaid, balance_due: balanceDue },
      invoiceType,
      filename
    );

    const resolvedPath = path.resolve(pdfPath);
    console.log(`📄 Invoice saved to: ${resolvedPath}`);

    await sendEmail({
      to: order.email,
      subject: `${invoiceType.toUpperCase()} Invoice — ${order.title}`,
      html: invoiceEmailTemplate({
        customerName: order.name,
        orderTitle: order.title,
        invoiceType,
        amount:
          invoiceType === "deposit"
            ? Number(order.deposit)
            : Number(order.balance),
        link: `${FRONTEND_URL}/pay?order=${order.id}&type=${invoiceType}`,
      }),
      attachments: [{ filename, path: resolvedPath }],
    });

    const flag =
      invoiceType === "deposit" ? "deposit_invoiced" : "balance_invoiced";
    await pool.query(`UPDATE orders SET ${flag}=TRUE WHERE id=$1`, [id]);

    res.json({
      success: true,
      message: `${invoiceType} invoice emailed successfully.`,
    });
  } catch (err) {
    console.error(`❌ Error sending ${type} invoice:`, err);
    res
      .status(500)
      .json({ success: false, error: `Failed to send ${type} invoice.` });
  }
});

/* ============================================================
   🔁 GET /api/orders/:id/refresh
============================================================ */
router.get("/:id/refresh", async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `
      SELECT o.*, c.business AS customer_business, c.name AS customer_name,
             c.email AS customer_email, c.phone AS customer_phone,
             c.address1, c.address2, c.city, c.county, c.postcode,
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

    const totalPaid = payments
      .filter((p) => p.status === "paid")
      .reduce((sum, p) => sum + Number(p.amount), 0);

    res.json({ success: true, data: { ...order, payments, total_paid: totalPaid } });
  } catch (err) {
    console.error("❌ Error refreshing order:", err);
    res.status(500).json({ success: false, error: "Failed to refresh order." });
  }
});

export default router;
