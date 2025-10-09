/**
 * ============================================================
 * PJH Web Services — Orders & Invoicing API (2025 Unified)
 * ============================================================
 * Handles:
 *  ✅ Order lifecycle and quote conversion
 *  ✅ Stripe payment & Direct Debit integration
 *  ✅ Invoice generation + email delivery
 *  ✅ Payment history + reconciliation display
 * ============================================================
 */

import express from "express";
import fs from "fs";
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
   🔍 FETCH SINGLE ORDER + PAYMENT STATUS
============================================================ */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `
      SELECT 
        o.*,
        c.business AS customer_business,
        c.name     AS customer_name,
        c.email    AS customer_email,
        c.phone    AS customer_phone,
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

    // Get all payments for this order
    const { rows: payments } = await pool.query(
      `SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at ASC`,
      [id]
    );

    const depositPayment = payments.find((p) => p.type === "deposit");
    const balancePayment = payments.find((p) => p.type === "balance");

    res.json({
      success: true,
      data: {
        ...order,
        payments,
        deposit_payment: depositPayment || null,
        balance_payment: balancePayment || null,
      },
    });
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
    // Avoid duplicates
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

    // Load quote
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
   💳 GENERATE STRIPE PAYMENT LINK (DEPOSIT/BALANCE)
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

    // Create Stripe Checkout
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "gbp",
            product_data: {
              name: `${type === "deposit" ? "Deposit" : "Balance"} — ${
                order.title
              }`,
            },
            unit_amount: Math.round(amount * 100),
          },
          quantity: 1,
        },
      ],
      metadata: {
        order_id: id,
        customer_id: order.customer_id,
        payment_type: type,
      },
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
    });

    res.json({
      success: true,
      message: "Payment link created & emailed successfully.",
      url: session.url,
    });
  } catch (err) {
    console.error("❌ Error creating payment link:", err);
    res.status(500).json({ success: false, error: "Failed to create link." });
  }
});

/* ============================================================
   💰 RECORD MANUAL PAYMENT
============================================================ */
router.post("/:id/payments", async (req, res) => {
  const { id } = req.params;
  const { amount, type, method, reference } = req.body;

  try {
    const { rows: orders } = await pool.query("SELECT * FROM orders WHERE id=$1", [id]);
    if (!orders.length)
      return res.status(404).json({ success: false, error: "Order not found." });

    await pool.query(
      `INSERT INTO payments (order_id, amount, type, method, reference, status)
       VALUES ($1,$2,$3,$4,$5,'paid')`,
      [id, amount, type, method, reference]
    );

    const flag =
      type === "deposit"
        ? "deposit_paid"
        : type === "balance"
        ? "balance_paid"
        : null;

    if (flag)
      await pool.query(
        `UPDATE orders SET total_paid = COALESCE(total_paid,0) + $1, ${flag}=TRUE WHERE id=$2`,
        [amount, id]
      );

    res.json({ success: true, message: "Payment recorded successfully." });
  } catch (err) {
    console.error("❌ Error recording payment:", err);
    res.status(500).json({ success: false, error: "Failed to record payment." });
  }
});

/* ============================================================
   📜 GET ALL PAYMENTS FOR ORDER
============================================================ */
router.get("/:id/payments", async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      "SELECT * FROM payments WHERE order_id=$1 ORDER BY created_at ASC",
      [id]
    );

    const paid = rows
      .filter((r) => r.status === "paid")
      .reduce((sum, p) => sum + Number(p.amount), 0);

    res.json({ success: true, payments: rows, total_paid: paid });
  } catch (err) {
    console.error("❌ Error fetching payments:", err);
    res.status(500).json({ success: false, error: "Failed to fetch payments." });
  }
});

/* ============================================================
   🧾 GENERATE + SEND INVOICE (PDF)
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
      attachments: [{ filename: `invoice-${order.id}.pdf`, path: pdfPath }],
    });

    const flag =
      invoiceType === "deposit" ? "deposit_invoiced" : "balance_invoiced";
    await pool.query(`UPDATE orders SET ${flag}=TRUE WHERE id=$1`, [id]);

    res.json({
      success: true,
      message: `${invoiceType} invoice sent successfully.`,
    });
  } catch (err) {
    console.error(`❌ Error sending ${type} invoice:`, err);
    res.status(500).json({ success: false, error: `Failed to send ${type} invoice.` });
  }
});

export default router;
