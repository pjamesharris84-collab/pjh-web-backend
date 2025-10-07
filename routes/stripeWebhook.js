// ============================================
// PJH Web Services — Stripe Webhook Handler
// ============================================

import express from "express";
import Stripe from "stripe";
import dotenv from "dotenv";
import { pool } from "../db.js";
import { sendEmail } from "../utils/email.js";

dotenv.config();

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * Stripe requires express.raw() for signature verification.
 * Mounted in index.js before JSON middleware.
 */
router.post("/webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // 🎯 We only care about successful checkout sessions
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    console.log("✅ Stripe checkout completed:", session.id);

    try {
      const orderId = Number(session.metadata?.orderId);
      const paymentType = session.metadata?.paymentType || "full";
      if (!orderId) {
        console.warn("⚠️ No orderId in session metadata — skipping.");
        return res.json({ received: true });
      }

      const paidAmount = Number(session.amount_total || 0) / 100;
      const paymentIntentId = session.payment_intent || "unknown_intent";

      // 💾 Record payment in DB
      await pool.query(
        `INSERT INTO payments (order_id, amount, type, method, reference)
         VALUES ($1, $2, $3, $4, $5)`,
        [orderId, paidAmount, paymentType, "card", paymentIntentId]
      );

      // 🧮 Recalculate totals and outstanding balance
      const { rows: orderRows } = await pool.query(
        "SELECT * FROM orders WHERE id=$1",
        [orderId]
      );
      if (!orderRows.length) return res.json({ received: true });
      const order = orderRows[0];

      const { rows: payments } = await pool.query(
        "SELECT amount FROM payments WHERE order_id=$1",
        [orderId]
      );
      const paid = payments.reduce((sum, p) => sum + Number(p.amount), 0);
      const total = Number(order.deposit || 0) + Number(order.balance || 0);
      const outstanding = Math.max(0, total - paid);

      // 🔍 Get customer info
      const { rows: custRows } = await pool.query(
        "SELECT name, email, business FROM customers WHERE id=$1",
        [order.customer_id]
      );
      const customer = custRows[0] || {};

      // 💌 Send a styled HTML payment receipt to customer
      const receiptHtml = paymentReceiptTemplate({
        customerName: customer.name,
        orderId,
        orderTitle: order.title,
        paidAmount,
        total,
        paid,
        outstanding,
        type: paymentType,
      });

      await sendEmail({
        to: customer.email || process.env.TO_EMAIL || process.env.SMTP_USER,
        subject: `Payment Receipt — ${order.title}`,
        html: receiptHtml,
        text: `Thank you for your payment of £${paidAmount.toFixed(2)} for your order "${order.title}". 
Total: £${total.toFixed(2)} | Paid to date: £${paid.toFixed(2)} | Outstanding: £${outstanding.toFixed(2)}

— PJH Web Services`,
      });

      // 🧾 Optional: Notify admin of received payment
      if (process.env.NOTIFY_ADMIN_ON_PAYMENT === "true") {
        await sendEmail({
          to: process.env.TO_EMAIL || process.env.SMTP_USER,
          subject: `Payment received — ${order.title}`,
          text: `£${paidAmount.toFixed(2)} received for Order #${orderId}.
Customer: ${customer.name || "Unknown"} (${customer.email || "no email"})
Outstanding now: £${outstanding.toFixed(2)}.`,
        });
      }

      console.log(`💰 Payment recorded for Order #${orderId}: £${paidAmount}`);
    } catch (err) {
      console.error("❌ Error handling checkout.session.completed:", err);
    }
  }

  // ✅ Always respond 200 so Stripe doesn't retry
  return res.json({ received: true });
});

export default router;

/* =======================================================
   Email Template: Payment Receipt
   ======================================================= */
function paymentReceiptTemplate({
  customerName,
  orderId,
  orderTitle,
  paidAmount,
  total,
  paid,
  outstanding,
  type,
}) {
  return `
  <html>
    <body style="font-family: 'Segoe UI', Helvetica, Arial, sans-serif; background-color: #f4f6f8; padding: 40px;">
      <table width="100%" style="max-width: 600px; margin: auto; background: #fff; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.05); overflow: hidden;">
        <tr>
          <td style="background: #0d1117; text-align: center; padding: 20px;">
            <img src="https://www.pjhwebservices.co.uk/assets/logo-light.png" alt="PJH Web Services" style="height: 60px;">
            <h2 style="color: #58a6ff; margin: 10px 0 0;">Payment Receipt</h2>
          </td>
        </tr>
        <tr>
          <td style="padding: 30px;">
            <p style="color: #333;">Hi ${customerName || "Customer"},</p>
            <p style="color: #333; line-height: 1.6;">
              Thank you for your <strong>${type}</strong> payment of <strong>£${paidAmount.toFixed(
    2
  )}</strong> for your order <strong>${orderTitle}</strong>.
            </p>

            <table style="width:100%; border-collapse: collapse; margin: 20px 0;">
              <tr style="background:#f0f3f6;">
                <td style="padding:10px 15px;">Total Order Value</td>
                <td style="padding:10px 15px; text-align:right;">£${total.toFixed(2)}</td>
              </tr>
              <tr>
                <td style="padding:10px 15px;">Total Paid to Date</td>
                <td style="padding:10px 15px; text-align:right;">£${paid.toFixed(2)}</td>
              </tr>
              <tr style="background:#f0f3f6;">
                <td style="padding:10px 15px;">Outstanding Balance</td>
                <td style="padding:10px 15px; text-align:right; font-weight:600;">£${outstanding.toFixed(
                  2
                )}</td>
              </tr>
            </table>

            <p style="color: #666; font-size: 14px; line-height: 1.5;">
              Your payment has been securely processed via Stripe.
              You will receive another update once your order is complete.
            </p>

            <p style="color: #777; font-size: 13px; margin-top: 30px;">
              Kind regards,<br>
              <strong>PJH Web Services</strong><br>
              <a href="https://www.pjhwebservices.co.uk" style="color:#007bff;">www.pjhwebservices.co.uk</a>
            </p>
          </td>
        </tr>
        <tr>
          <td style="background: #0d1117; color: #999; text-align: center; font-size: 12px; padding: 10px;">
            © ${new Date().getFullYear()} PJH Web Services — All Rights Reserved
          </td>
        </tr>
      </table>
    </body>
  </html>
  `;
}
