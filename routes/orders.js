/**
 * ============================================================
 * PJH Web Services — Orders & Invoicing API
 * ============================================================
 * Handles order lifecycle, payments, and invoice generation.
 * Includes PDF creation, Stripe payment link integration,
 * and styled HTML email automation.
 * ============================================================
 */

import express from "express";
import fs from "fs";
import pool from "../db.js";
import { sendEmail } from "../utils/email.js";
import { generateInvoicePDF } from "../utils/invoice.js";
import Stripe from "stripe";
import dotenv from "dotenv";
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

/* -----------------------------
   GET /api/orders
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

/* -----------------------------
   GET /api/orders/:id
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
        c.address1, c.address2, c.city, c.county, c.postcode
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      WHERE o.id = $1;
      `,
      [req.params.id]
    );

    if (rows.length === 0)
      return res
        .status(404)
        .json({ success: false, error: "Order not found." });

    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error("❌ Error fetching order:", err);
    res.status(500).json({ success: false, error: "Failed to fetch order." });
  }
});

/* -----------------------------
   POST /api/orders/from-quote/:quoteId
-------------------------------- */
router.post("/from-quote/:quoteId", async (req, res) => {
  const { quoteId } = req.params;
  try {
    // 1️⃣ Check if order already exists
    const existing = await pool.query(
      "SELECT * FROM orders WHERE quote_id = $1 LIMIT 1",
      [quoteId]
    );
    if (existing.rows.length > 0) {
      return res.json({
        message: "Order already exists for this quote.",
        data: existing.rows[0],
      });
    }

    // 2️⃣ Get quote details
    const quoteRes = await pool.query("SELECT * FROM quotes WHERE id = $1", [
      quoteId,
    ]);
    if (quoteRes.rows.length === 0)
      return res.status(404).json({ error: "Quote not found." });
    const quote = quoteRes.rows[0];

    // 3️⃣ Create order
    const totalItems = (quote.items || []).reduce(
      (sum, i) => sum + (i.total || 0),
      0
    );
    const balance = totalItems - (quote.deposit || 0);

    const newOrder = await pool.query(
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
        JSON.stringify(quote.items || []),
        quote.deposit || 0,
        balance,
      ]
    );

    res.json({
      message: "✅ Order created successfully from quote.",
      data: newOrder.rows[0],
    });
  } catch (err) {
    console.error("❌ Error creating order:", err);
    res.status(500).json({ error: "Failed to create order." });
  }
});

/* -----------------------------
   POST /api/orders/:id/payment-link/:type
   Generate Stripe payment link (deposit/balance)
-------------------------------- */
router.post("/:id/payment-link/:type", async (req, res) => {
  const { id, type } = req.params;

  if (!["deposit", "balance"].includes(type))
    return res
      .status(400)
      .json({ success: false, error: "Invalid payment type." });

  try {
    // Fetch order + customer
    const { rows } = await pool.query(
      `
      SELECT o.*, c.name, c.email
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      WHERE o.id=$1;
      `,
      [id]
    );
    if (rows.length === 0)
      return res
        .status(404)
        .json({ success: false, error: "Order not found." });

    const order = rows[0];
    const amount =
      type === "deposit" ? Number(order.deposit) : Number(order.balance);

    if (amount <= 0)
      return res
        .status(400)
        .json({ success: false, error: "No outstanding amount." });

    // Create Stripe checkout
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "gbp",
            product_data: {
              name: `${
                type === "deposit" ? "Deposit" : "Balance"
              } — ${order.title}`,
            },
            unit_amount: Math.round(amount * 100),
          },
          quantity: 1,
        },
      ],
      metadata: { orderId: id, paymentType: type },
      success_url: `${FRONTEND_URL}/payment-success?order=${id}`,
      cancel_url: `${FRONTEND_URL}/payment-cancelled?order=${id}`,
      customer_email: order.email,
    });

    const paymentUrl = session.url;

    // Send branded HTML email
    await sendEmail({
      to: order.email,
      subject: `Secure ${type} payment link — ${order.title}`,
      html: paymentRequestTemplate({
        customerName: order.name,
        orderTitle: order.title,
        amount,
        link: paymentUrl,
        type,
      }),
      text: `Please complete your ${type} payment of £${amount.toFixed(
        2
      )} using the link below:\n\n${paymentUrl}`,
    });

    res.json({
      success: true,
      message: "Payment link sent to customer.",
      url: paymentUrl,
    });
  } catch (err) {
    console.error("❌ Error creating payment link:", err);
    res
      .status(500)
      .json({ success: false, error: "Failed to create payment link." });
  }
});

/* -----------------------------
   POST /api/orders/:id/payments
-------------------------------- */
router.post("/:id/payments", async (req, res) => {
  const { id } = req.params;
  const { amount, type, method, reference } = req.body;

  try {
    const orderRes = await pool.query("SELECT * FROM orders WHERE id=$1", [
      id,
    ]);
    if (orderRes.rows.length === 0)
      return res
        .status(404)
        .json({ success: false, error: "Order not found." });

    // Insert payment
    await pool.query(
      `INSERT INTO payments (order_id, amount, type, method, reference)
       VALUES ($1,$2,$3,$4,$5)`,
      [id, amount, type, method, reference]
    );

    // Update paid flags
    if (type === "deposit")
      await pool.query("UPDATE orders SET deposit_paid=true WHERE id=$1", [
        id,
      ]);
    if (type === "balance")
      await pool.query("UPDATE orders SET balance_paid=true WHERE id=$1", [
        id,
      ]);

    res.json({ success: true, message: "Payment recorded successfully." });
  } catch (err) {
    console.error("❌ Error recording payment:", err);
    res.status(500).json({ success: false, error: "Failed to record payment." });
  }
});

/* -----------------------------
   GET /api/orders/:id/payments
-------------------------------- */
router.get("/:id/payments", async (req, res) => {
  try {
    const { rows: orderRows } = await pool.query(
      "SELECT * FROM orders WHERE id=$1",
      [req.params.id]
    );
    if (orderRows.length === 0)
      return res
        .status(404)
        .json({ success: false, error: "Order not found." });

    const order = orderRows[0];
    const { rows: paymentRows } = await pool.query(
      "SELECT * FROM payments WHERE order_id=$1",
      [order.id]
    );
    const paid = paymentRows.reduce((s, p) => s + Number(p.amount), 0);
    const total = Number(order.deposit) + Number(order.balance);
    const outstanding = total - paid;

    res.json({ success: true, payments: paymentRows, paid, outstanding });
  } catch (err) {
    console.error("❌ Error fetching payments:", err);
    res.status(500).json({ success: false, error: "Failed to fetch payments." });
  }
});

/* -----------------------------
   POST /api/orders/:id/invoice/:type
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

    if (rows.length === 0)
      return res
        .status(404)
        .json({ success: false, error: "Order not found." });

    const order = rows[0];
    const pdfPath = await generateInvoicePDF(order, invoiceType);

    // ✉️ Send beautiful styled invoice email
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
        link: `${FRONTEND_URL}/pay?order=${order.id}&type=${invoiceType}`, // Optional
      }),
      text: `Please find attached your ${invoiceType} invoice.`,
      attachments: [{ filename: `invoice-${order.id}.pdf`, path: pdfPath }],
    });

    if (invoiceType === "deposit")
      await pool.query("UPDATE orders SET deposit_invoiced = true WHERE id=$1", [
        id,
      ]);
    if (invoiceType === "balance")
      await pool.query("UPDATE orders SET balance_invoiced = true WHERE id=$1", [
        id,
      ]);

    res.json({
      success: true,
      message: `${invoiceType} invoice sent successfully.`,
    });
  } catch (err) {
    console.error(`❌ Error sending ${type} invoice:`, err);
    res
      .status(500)
      .json({ success: false, error: `Failed to send ${type} invoice.` });
  }
});

export default router;
