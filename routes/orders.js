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

/* ============================================================
   🧱 FETCH ALL ORDERS
============================================================ */
router.get("/", async (_req, res) => {
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

/* ============================================================
   🧩 FETCH ORDERS BY CUSTOMER
============================================================ */
router.get("/customers/:customerId/orders", async (req, res) => {
  const { customerId } = req.params;
  try {
    const { rows } = await pool.query(
      `
      SELECT o.*, c.business, c.name, c.email
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      WHERE o.customer_id = $1
      ORDER BY o.created_at DESC;
      `,
      [customerId]
    );
    res.json({ success: true, orders: rows });
  } catch (err) {
    console.error("❌ Error fetching orders by customer:", err);
    res
      .status(500)
      .json({ success: false, error: "Failed to fetch orders by customer." });
  }
});

/* ============================================================
   🔍 FETCH SINGLE ORDER
============================================================ */
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

    if (!rows.length)
      return res.status(404).json({ success: false, error: "Order not found." });

    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error("❌ Error fetching order:", err);
    res.status(500).json({ success: false, error: "Failed to fetch order." });
  }
});

/* ============================================================
   🪄 CREATE ORDER FROM QUOTE
============================================================ */
router.post("/from-quote/:quoteId", async (req, res) => {
  const { quoteId } = req.params;
  try {
    const existing = await pool.query(
      "SELECT * FROM orders WHERE quote_id = $1 LIMIT 1",
      [quoteId]
    );
    if (existing.rows.length)
      return res.json({
        success: true,
        message: "Order already exists for this quote.",
        data: existing.rows[0],
      });

    const quoteRes = await pool.query("SELECT * FROM quotes WHERE id = $1", [
      quoteId,
    ]);
    if (!quoteRes.rows.length)
      return res.status(404).json({ success: false, error: "Quote not found." });

    const quote = quoteRes.rows[0];
    const items = Array.isArray(quote.items)
      ? quote.items
      : JSON.parse(quote.items || "[]");
    const total = items.reduce(
      (sum, i) => sum + Number(i.qty ?? 1) * Number(i.unit_price ?? i.price ?? 0),
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
   💳 GENERATE PAYMENT LINK
============================================================ */
router.post("/:id/payment-link/:type", async (req, res) => {
  const { id, type } = req.params;
  if (!["deposit", "balance"].includes(type))
    return res.status(400).json({ success: false, error: "Invalid type." });

  try {
    const { rows } = await pool.query(
      `
      SELECT o.*, c.name, c.email
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      WHERE o.id=$1;
      `,
      [id]
    );
    if (!rows.length)
      return res.status(404).json({ success: false, error: "Order not found." });

    const order = rows[0];
    const amount =
      type === "deposit" ? Number(order.deposit) : Number(order.balance);

    if (amount <= 0)
      return res
        .status(400)
        .json({ success: false, error: "No outstanding amount." });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "gbp",
            product_data: {
              name: `${type === "deposit" ? "Deposit" : "Balance"} — ${order.title}`,
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

    await sendEmail({
      to: order.email,
      subject: `Secure ${type} payment link — ${order.title}`,
      html: paymentRequestTemplate({
        customerName: order.name,
        orderTitle: order.title,
        amount,
        link: session.url,
        type,
      }),
      text: `Please complete your ${type} payment of £${amount.toFixed(
        2
      )} using this link:\n${session.url}`,
    });

    res.json({
      success: true,
      message: "Payment link created & emailed.",
      url: session.url,
    });
  } catch (err) {
    console.error("❌ Error creating payment link:", err);
    res.status(500).json({ success: false, error: "Failed to create link." });
  }
});

/* ============================================================
   💰 RECORD PAYMENT
============================================================ */
router.post("/:id/payments", async (req, res) => {
  const { id } = req.params;
  const { amount, type, method, reference } = req.body;

  try {
    const orderRes = await pool.query("SELECT * FROM orders WHERE id=$1", [id]);
    if (!orderRes.rows.length)
      return res.status(404).json({ success: false, error: "Order not found." });

    await pool.query(
      `INSERT INTO payments (order_id, amount, type, method, reference)
       VALUES ($1,$2,$3,$4,$5)`,
      [id, amount, type, method, reference]
    );

    if (type === "deposit")
      await pool.query("UPDATE orders SET deposit_paid=true WHERE id=$1", [id]);
    if (type === "balance")
      await pool.query("UPDATE orders SET balance_paid=true WHERE id=$1", [id]);

    res.json({ success: true, message: "Payment recorded successfully." });
  } catch (err) {
    console.error("❌ Error recording payment:", err);
    res.status(500).json({ success: false, error: "Failed to record payment." });
  }
});

/* ============================================================
   📜 GET PAYMENTS FOR ORDER
============================================================ */
router.get("/:id/payments", async (req, res) => {
  try {
    const { rows: orderRows } = await pool.query(
      "SELECT * FROM orders WHERE id=$1",
      [req.params.id]
    );
    if (!orderRows.length)
      return res.status(404).json({ success: false, error: "Order not found." });

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

/* ============================================================
   🧾 SEND INVOICE (Deposit/Balance)
============================================================ */
router.post("/:id/invoice/:type", async (req, res) => {
  const { id, type } = req.params;
  const invoiceType = type.toLowerCase();

  if (!["deposit", "balance"].includes(invoiceType))
    return res.status(400).json({ success: false, error: "Invalid invoice type." });

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

    if (!rows.length)
      return res.status(404).json({ success: false, error: "Order not found." });

    const order = rows[0];
    const pdfPath = await generateInvoicePDF(order, invoiceType);

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
      text: `Please find attached your ${invoiceType} invoice.`,
      attachments: [{ filename: `invoice-${order.id}.pdf`, path: pdfPath }],
    });

    if (invoiceType === "deposit")
      await pool.query("UPDATE orders SET deposit_invoiced=true WHERE id=$1", [id]);
    if (invoiceType === "balance")
      await pool.query("UPDATE orders SET balance_invoiced=true WHERE id=$1", [id]);

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
