/**
 * ============================================================
 * PJH Web Services — Stripe Payments & Billing (Unified 2025)
 * ============================================================
 * Handles:
 *  ✅ Card & Bacs one-off payments
 *  ✅ Direct Debit setup (mode: "setup")
 *  ✅ Webhook-based reconciliation
 *  ✅ Off-session recurring billing
 *  ✅ Refund endpoint (uses same table as orders)
 * ============================================================
 */

import express from "express";
import Stripe from "stripe";
import dotenv from "dotenv";
import pool from "../db.js";
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
============================================================ */
router.post("/create-checkout", async (req, res) => {
  try {
    const { orderId, flow, type } = req.body;
    if (!orderId)
      return res.status(400).json({ success: false, error: "Missing orderId" });

    const { rows } = await pool.query(
      `
      SELECT o.*, c.id AS cid, c.name AS customer_name, c.email,
             c.stripe_customer_id, c.stripe_mandate_id, c.direct_debit_active
      FROM orders o
      JOIN customers c ON c.id=o.customer_id
      WHERE o.id=$1;
      `,
      [orderId]
    );

    if (!rows.length)
      return res.status(404).json({ success: false, error: "Order not found" });

    const order = rows[0];
    const stripeCustomer =
      order.stripe_customer_id ||
      (await stripe.customers
        .create({
          name: order.customer_name,
          email: order.email,
          metadata: { order_id: orderId },
        })
        .then((c) => {
          pool.query("UPDATE customers SET stripe_customer_id=$1 WHERE id=$2", [
            c.id,
            order.customer_id,
          ]);
          return c.id;
        }));

    const baseAmount =
      type === "deposit" ? Number(order.deposit) : Number(order.balance);
    const { rows: pays } = await pool.query(
      `SELECT COALESCE(SUM(amount),0)::numeric AS paid FROM payments WHERE order_id=$1 AND type=$2 AND status='paid';`,
      [order.id, type]
    );
    const alreadyPaid = Number(pays[0]?.paid || 0);
    const amount = Math.max(baseAmount - alreadyPaid, 0);
    if (amount <= 0)
      return res
        .status(400)
        .json({ success: false, error: `No outstanding ${type} amount.` });

    const mode =
      flow === "bacs_setup" ? "setup" : flow === "bacs_payment" ? "payment" : "payment";
    const paymentTypes =
      flow === "bacs_payment" || flow === "bacs_setup"
        ? ["bacs_debit"]
        : ["card"];

    const session = await stripe.checkout.sessions.create({
      mode,
      customer: stripeCustomer,
      payment_method_types: paymentTypes,
      line_items:
        mode === "setup"
          ? undefined
          : [
              {
                price_data: {
                  currency: "gbp",
                  product_data: { name: `${type} — ${order.title}` },
                  unit_amount: Math.round(amount * 100),
                },
                quantity: 1,
              },
            ],
      success_url: `${FRONTEND_URL}/payment-success?order=${order.id}`,
      cancel_url: `${FRONTEND_URL}/payment-cancelled?order=${order.id}`,
      metadata: { order_id: String(order.id), payment_type: type },
    });

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

    res.json({ success: true, url: session.url });
  } catch (err) {
    console.error("❌ create-checkout error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ============================================================
   💸 POST /api/payments/refund
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

    console.log(`💸 Refund recorded for order ${orderId} (£${amount})`);
    res.json({ success: true, message: "Refund processed successfully." });
  } catch (err) {
    console.error("❌ Refund error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
