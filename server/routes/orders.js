/**
 * ============================================================
 * PJH Web Services — Orders & Invoicing API
 * ============================================================
 * Handles order lifecycle, payments, and invoice generation.
 * Includes PDF creation and email sending for deposits/balances.
 * ============================================================
 */

import express from "express";
import pool from "../db.js";
import { sendEmail } from "../utils/email.js";
import { generateInvoicePDF } from "../utils/invoice.js";
import fs from "fs";

const router = express.Router();

/* -----------------------------
   GET /api/orders
   Fetch all orders with customer data
-------------------------------- */
router.get("/", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT 
        o.*,
        c.business AS customer_business,
        c.name     AS customer_name,
        c.email    AS customer_email,
        c.phone    AS customer_phone,
        c.address1,
        c.address2,
        c.city,
        c.county,
        c.postcode
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

/* -----------------------------
   GET /api/orders/:id
   Fetch single order with customer details
-------------------------------- */
router.get("/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT 
        o.*,
        c.business AS customer_business,
        c.name     AS customer_name,
        c.email    AS customer_email,
        c.phone    AS customer_phone,
        c.address1,
        c.address2,
        c.city,
        c.county,
        c.postcode
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      WHERE o.id = $1;
      `,
      [req.params.id]
    );

    if (rows.length === 0) return res.status(404).json({ success: false, error: "Order not found." });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error("❌ Error fetching order:", err);
    res.status(500).json({ success: false, error: "Failed to fetch order." });
  }
});

// ============================================
// 🆕 Create Order from Quote
// ============================================
router.post("/from-quote/:quoteId", async (req, res) => {
  const { quoteId } = req.params;

  try {
    // 1️⃣ Check if order already exists for this quote
    const existing = await pool.query(
      "SELECT * FROM orders WHERE quote_id = $1 LIMIT 1",
      [quoteId]
    );
    if (existing.rows.length > 0) {
      console.log("⚠️ Order already exists for quote:", quoteId);
      return res.status(200).json({
        message: "Order already exists for this quote.",
        data: existing.rows[0],
      });
    }

    // 2️⃣ Fetch the quote details
    const quoteResult = await pool.query(
      "SELECT * FROM quotes WHERE id = $1",
      [quoteId]
    );
    if (quoteResult.rows.length === 0) {
      return res.status(404).json({ error: "Quote not found" });
    }
    const quote = quoteResult.rows[0];

    // 3️⃣ Create the new order using quote info
    const newOrder = await pool.query(
      `
      INSERT INTO orders (
        customer_id,
        quote_id,
        title,
        description,
        status,
        items,
        deposit,
        balance,
        tasks,
        diary
      )
      VALUES ($1, $2, $3, $4, 'in_progress', $5, $6, $7, '[]', '[]')
      RETURNING *;
      `,
      [
        quote.customer_id,
        quote.id,
        quote.title,
        quote.description || "",
        JSON.stringify(quote.items || []),
        quote.deposit || 0,
        (quote.items || []).reduce((s, i) => s + (i.total || 0), 0) -
          (quote.deposit || 0),
      ]
    );

    console.log("✅ Order created from quote:", newOrder.rows[0].id);

    res.json({
      message: "Order created successfully from quote.",
      data: newOrder.rows[0],
    });
  } catch (err) {
    console.error("❌ Error creating order from quote:", err);
    res.status(500).json({
      error: "Failed to create order.",
      details: err.message,
    });
  }
});


/* -----------------------------
   DELETE /api/orders/:id
   Delete an order by ID
-------------------------------- */
router.delete("/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "DELETE FROM orders WHERE id = $1 RETURNING id",
      [req.params.id]
    );

    if (rows.length === 0) return res.status(404).json({ success: false, error: "Order not found." });
    res.json({ success: true, message: "Order deleted successfully." });
  } catch (err) {
    console.error("❌ Error deleting order:", err);
    res.status(500).json({ success: false, error: "Failed to delete order." });
  }
});

/* -----------------------------
   POST /api/orders/:id/tasks
   Toggle or update task list for an order
-------------------------------- */
router.post("/:id/tasks", async (req, res) => {
  const { id } = req.params;
  const { task } = req.body;

  try {
    const orderRes = await pool.query("SELECT * FROM orders WHERE id=$1", [id]);
    if (orderRes.rows.length === 0) return res.status(404).json({ success: false, error: "Order not found." });

    let tasks = orderRes.rows[0].tasks || [];
    if (typeof tasks === "string") {
      try { tasks = JSON.parse(tasks); } catch { tasks = []; }
    }

    tasks = tasks.includes(task) ? tasks.filter((t) => t !== task) : [...tasks, task];

    const { rows } = await pool.query(
      "UPDATE orders SET tasks=$1 WHERE id=$2 RETURNING *",
      [JSON.stringify(tasks), id]
    );

    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error("❌ Error updating tasks:", err);
    res.status(500).json({ success: false, error: "Failed to update tasks." });
  }
});

/* -----------------------------
   POST /api/orders/:id/diary
   Add a diary note
-------------------------------- */
router.post("/:id/diary", async (req, res) => {
  const { id } = req.params;
  const { note } = req.body;

  if (!note || note.trim() === "")
    return res.status(400).json({ success: false, error: "Note is required." });

  try {
    const { rows } = await pool.query(
      "INSERT INTO order_diary (order_id, note) VALUES ($1, $2) RETURNING *",
      [id, note]
    );

    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error("❌ Error adding diary note:", err);
    res.status(500).json({ success: false, error: "Failed to add diary note." });
  }
});

/* -----------------------------
   GET /api/orders/:id/diary
   Fetch all diary notes for an order
-------------------------------- */
router.get("/:id/diary", async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      "SELECT * FROM order_diary WHERE order_id=$1 ORDER BY date DESC",
      [id]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("❌ Error fetching diary notes:", err);
    res.status(500).json({ success: false, error: "Failed to fetch diary notes." });
  }
});

/* -----------------------------
   POST /api/orders/:id/payments
   Record a payment against an order
-------------------------------- */
router.post("/:id/payments", async (req, res) => {
  const { id } = req.params;
  const { amount, type, method, reference } = req.body;

  try {
    const orderRes = await pool.query("SELECT * FROM orders WHERE id=$1", [id]);
    if (orderRes.rows.length === 0) return res.status(404).json({ success: false, error: "Order not found." });

    const { rows } = await pool.query(
      `
      INSERT INTO payments (order_id, amount, type, method, reference)
      VALUES ($1,$2,$3,$4,$5)
      RETURNING *;
      `,
      [id, amount, type, method, reference]
    );

    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error("❌ Error recording payment:", err);
    res.status(500).json({ success: false, error: "Failed to record payment." });
  }
});

/* -----------------------------
   GET /api/orders/:id/payments
   Get all payments and outstanding total
-------------------------------- */
router.get("/:id/payments", async (req, res) => {
  try {
    const { rows: orderRows } = await pool.query("SELECT * FROM orders WHERE id=$1", [req.params.id]);
    if (orderRows.length === 0) return res.status(404).json({ success: false, error: "Order not found." });

    const order = orderRows[0];
    const { rows: paymentRows } = await pool.query("SELECT * FROM payments WHERE order_id=$1", [order.id]);

    const paid = paymentRows.reduce((sum, p) => sum + Number(p.amount), 0);
    const total = Number(order.deposit) + Number(order.balance);
    const outstanding = total - paid;

    res.json({ success: true, payments: paymentRows, paid, outstanding });
  } catch (err) {
    console.error("❌ Error fetching payments:", err);
    res.status(500).json({ success: false, error: "Failed to fetch payments." });
  }
});

/* -----------------------------
   GET /api/orders/:id/invoice/:type
   Preview invoice PDF (deposit / balance / full)
-------------------------------- */
router.get("/:id/invoice/:type", async (req, res) => {
  const { id, type } = req.params;
  const invoiceType = type.toLowerCase();

  try {
    const { rows } = await pool.query(
      `
      SELECT o.*, c.*
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      WHERE o.id = $1;
      `,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, error: "Order not found." });

    const order = rows[0];
    const customer = {
      name: order.name,
      business: order.business,
      email: order.email,
      phone: order.phone,
      address1: order.address1,
      address2: order.address2,
      city: order.city,
      county: order.county,
      postcode: order.postcode,
    };

    const pdfPath = await generateInvoicePDF(order, invoiceType);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename=invoice-${order.id}.pdf`);
    fs.createReadStream(pdfPath).pipe(res);
  } catch (err) {
    console.error(`❌ Error previewing ${type} invoice:`, err);
    res.status(500).json({ success: false, error: `Failed to preview ${type} invoice.` });
  }
});

/* -----------------------------
   POST /api/orders/:id/invoice/:type
   Generate and email an invoice
-------------------------------- */
router.post("/:id/invoice/:type", async (req, res) => {
  const { id, type } = req.params;
  const invoiceType = type.toLowerCase();

  try {
    const { rows } = await pool.query(
      `
      SELECT o.*, c.*
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      WHERE o.id = $1;
      `,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, error: "Order not found." });

    const order = rows[0];
    const customer = {
      name: order.name,
      business: order.business,
      email: order.email,
      phone: order.phone,
      address1: order.address1,
      address2: order.address2,
      city: order.city,
      county: order.county,
      postcode: order.postcode,
    };

    const pdfPath = await generateInvoicePDF(order, invoiceType);

    await sendEmail({
      to: order.email,
      subject: `${invoiceType.toUpperCase()} Invoice — ${order.title}`,
      text: `Please find attached your ${invoiceType} invoice.`,
      attachments: [{ filename: `invoice-${order.id}.pdf`, path: pdfPath }],
    });

    if (invoiceType === "deposit")
      await pool.query("UPDATE orders SET deposit_invoiced = true WHERE id=$1", [id]);
    if (invoiceType === "balance")
      await pool.query("UPDATE orders SET balance_invoiced = true WHERE id=$1", [id]);

    res.json({ success: true, message: `${invoiceType} invoice sent successfully.` });
  } catch (err) {
    console.error(`❌ Error sending ${type} invoice:`, err);
    res.status(500).json({ success: false, error: `Failed to send ${type} invoice.` });
  }
});

export default router;
