/**
 * ============================================================
 * PJH Web Services — Orders & Invoicing API (Unified Final 2025)
 * ============================================================
 * Handles:
 *  ✅ Order lifecycle & quote conversion
 *  ✅ Stripe & manual payments
 *  ✅ Refund-aware total reconciliation
 *  ✅ Invoice generation + email delivery
 *  ✅ Dynamic totals (paid, refunded, balance)
 *  ✅ Safe order deletion
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
   🧱 GET /api/orders — List all orders
============================================================ */
router.get("/", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT 
        o.*, 
        c.business AS customer_business, 
        c.name AS customer_name,
        c.email AS customer_email, 
        c.phone AS customer_phone
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
   🆕 POST /api/orders/from-quote/:quoteId
   Creates a new order from an existing quote (safe JSON insert)
============================================================ */
router.post("/from-quote/:quoteId", async (req, res) => {
  const { quoteId } = req.params;

  try {
    // 1️⃣ Get the quote
    const { rows: quoteRows } = await pool.query(
      "SELECT * FROM quotes WHERE id = $1;",
      [quoteId]
    );
    if (!quoteRows.length)
      return res.status(404).json({ success: false, error: "Quote not found." });

    const quote = quoteRows[0];

    // 2️⃣ Prevent duplicate orders
    const { rows: existing } = await pool.query(
      "SELECT id FROM orders WHERE quote_id = $1 LIMIT 1;",
      [quoteId]
    );
    if (existing.length)
      return res.status(400).json({
        success: false,
        error: "Order already exists for this quote.",
        order_id: existing[0].id,
      });

    // 3️⃣ Safely parse quote.items JSON
    let items = [];
    try {
      if (typeof quote.items === "string") items = JSON.parse(quote.items);
      else if (Array.isArray(quote.items)) items = quote.items;
      else items = [];
    } catch {
      console.warn("⚠️ Quote items could not be parsed; defaulting to []");
      items = [];
    }

    // 4️⃣ Calculate financials (robust to missing fields)
const deposit = Number(quote.deposit || 0);

// Ensure total always reflects full package + maintenance
const total =
  Number(quote.custom_price) ||
  Number(quote.total_after_discount) ||
  deposit * 2 || // fallback if quote uses 50% deposit logic
  0;

const balance = Math.max(total - deposit, 0);


    // 5️⃣ Insert order (force valid JSONB)
    const { rows: inserted } = await pool.query(
      `
      INSERT INTO orders (
        customer_id, quote_id, title, description, items,
        deposit, balance, status, tasks, diary, deposit_paid, balance_paid
      )
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,'in_progress','[]'::jsonb,'[]'::jsonb,false,false)
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

//  Link quote → order
await pool.query("UPDATE quotes SET order_id = $1 WHERE id = $2;", [newOrder.id, quote.id]);


    // 6️⃣ Update quote status → closed
    await pool.query("UPDATE quotes SET status = 'closed' WHERE id = $1;", [quoteId]);
    console.log(`🔒 Quote ${quoteId} marked as closed.`);

    res.json({ success: true, data: newOrder });
  } catch (err) {
    console.error("❌ Error creating order from quote:", err);
    res
      .status(500)
      .json({ success: false, error: "Failed to create order from quote." });
  }
});


/* ============================================================
   🔍 GET /api/orders/:id — Refund-aware totals
============================================================ */
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `
      SELECT 
        o.*, 
        c.business AS customer_business, 
        c.name AS customer_name,
        c.email AS customer_email, 
        c.phone AS customer_phone,
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

    const paid = payments
      .filter((p) => p.status === "paid" && p.amount > 0)
      .reduce((sum, p) => sum + Number(p.amount), 0);

    const refunded = payments
      .filter((p) => p.status === "refunded" || p.amount < 0)
      .reduce((sum, p) => sum + Math.abs(Number(p.amount)), 0);

    //  Calculate full totals (robust)
const total = Number(order.deposit || 0) + Number(order.balance || 0);
const paidTotal = paid;
const refundedTotal = refunded;
const balanceDue = Math.max(total - (paidTotal - refundedTotal), 0);

//  Return explicit totals for the frontend
res.json({
  success: true,
  data: {
    ...order,
    payments,
    total,
    total_paid: paidTotal,
    refunded_total: refundedTotal,
    balance_due: balanceDue,
  },
});

  } catch (err) {
    console.error("❌ Error fetching order:", err);
    res.status(500).json({ success: false, error: "Failed to fetch order." });
  }
});

/* ============================================================
   💰 GET /api/orders/:id/payments — Includes refunds
============================================================ */
router.get("/:orderId/payments", async (req, res) => {
  const { orderId } = req.params;
  try {
    const { rows } = await pool.query(
      `
      SELECT id, order_id, amount, type, method, status, reference, created_at
      FROM payments
      WHERE order_id = $1
      ORDER BY created_at DESC
      `,
      [orderId]
    );
    res.json({ success: true, payments: rows });
  } catch (err) {
    console.error("❌ Failed to fetch payments:", err);
    res.status(500).json({ success: false, error: "Failed to fetch payments" });
  }
});


/* ============================================================
   💸 POST /api/payments/refund — Stripe refund + record
   ------------------------------------------------------------
   • Validates payment_id and amount
   • Creates refund via Stripe API
   • Inserts negative "refund" payment entry
   • Protects against duplicates
============================================================ */
router.post("/refund", async (req, res) => {
  const { payment_id, amount } = req.body;

  if (!payment_id || !amount || isNaN(amount)) {
    return res.status(400).json({
      success: false,
      error: "Missing or invalid payment_id / amount.",
    });
  }

  try {
    // 🔍 Fetch payment
    const { rows } = await pool.query(
      "SELECT * FROM payments WHERE id=$1 LIMIT 1",
      [payment_id]
    );
    if (!rows.length) {
      return res.status(404).json({
        success: false,
        error: "Payment not found.",
      });
    }

    const payment = rows[0];
    const orderId = payment.order_id;
    const customerId = payment.customer_id;
    const stripeRef = payment.reference;

    if (!stripeRef) {
      return res.status(400).json({
        success: false,
        error: "This payment has no Stripe reference.",
      });
    }

    // 🧾 Prevent duplicate refund records
    const existingRefund = await pool.query(
      "SELECT 1 FROM payments WHERE reference=$1 AND type='refund' LIMIT 1",
      [stripeRef]
    );
    if (existingRefund.rowCount) {
      return res.status(400).json({
        success: false,
        error: "Refund already processed for this payment.",
      });
    }

    // 💸 Create refund in Stripe
    const refund = await stripe.refunds.create({
      payment_intent: stripeRef,
      amount: Math.round(Number(amount) * 100),
      reason: "requested_by_customer",
      metadata: {
        pjh_order_id: String(orderId),
        pjh_payment_id: String(payment_id),
      },
    });

    // 🧾 Record refund in DB (negative value, type='refund')
    await pool.query(
      `
      INSERT INTO payments 
        (order_id, customer_id, amount, type, method, status, reference, stripe_refund_id, refunded, refund_reason, created_at)
      VALUES ($1, $2, $3, 'refund', $4, 'refunded', $5, $6, TRUE, 'requested_by_customer', NOW());
      `,
      [
        orderId,
        customerId,
        -Math.abs(Number(amount)),
        payment.method || "card",
        refund.id,
        refund.id,
      ]
    );

    console.log(
      `💸 Refund issued: Order #${orderId} — £${Number(amount).toFixed(
        2
      )} (Stripe refund: ${refund.id})`
    );

    return res.json({
      success: true,
      message: `Refund of £${Number(amount).toFixed(
        2
      )} processed successfully.`,
      refund_id: refund.id,
      order_id: orderId,
    });
  } catch (err) {
    console.error("❌ Refund error:", err);
    return res.status(500).json({
      success: false,
      error: err.message || "Failed to process refund.",
    });
  }
});


/* ============================================================
   🔁 GET /api/orders/:id/refresh — Re-sync totals
============================================================ */
router.get("/:id/refresh", async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `
      SELECT 
        o.*, 
        c.business AS customer_business, 
        c.name AS customer_name,
        c.email AS customer_email, 
        c.phone AS customer_phone,
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

    res.json({
      success: true,
      data: { ...order, payments, total_paid: paid, refunded_total: refunded },
    });
  } catch (err) {
    console.error("❌ Error refreshing order:", err);
    res.status(500).json({ success: false, error: "Failed to refresh order." });
  }
});

/* ============================================================
   🗑️ DELETE /api/orders/:id — Delete order + dependencies
============================================================ */
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query("BEGIN");

    await pool.query("DELETE FROM payments WHERE order_id = $1;", [id]);
    const result = await pool.query("DELETE FROM orders WHERE id = $1 RETURNING *;", [id]);

    if (!result.rowCount) {
      await pool.query("ROLLBACK");
      return res.status(404).json({ success: false, error: "Order not found." });
    }

    await pool.query("COMMIT");
    console.log(`🗑️ Order ${id} and associated payments deleted.`);
    res.json({ success: true, message: "Order deleted successfully." });
  } catch (err) {
    await pool.query("ROLLBACK").catch(() => {});
    console.error("❌ Error deleting order:", err);
    res.status(500).json({ success: false, error: "Failed to delete order." });
  }
});

export default router;
