// routes/stripeWebhook.js
import express from "express";
import Stripe from "stripe";
import dotenv from "dotenv";
import { pool } from "../db.js";
import { sendEmail } from "../utils/email.js";

dotenv.config();

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-11-20.acacia",
});

/**
 * Stripe requires the raw body for signature verification.
 * Mount this route with express.raw() in server.js (see below).
 */
router.post("/webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // We care about successful checkout completion
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    try {
      const orderId = Number(session.metadata?.orderId);
      if (!orderId) {
        console.warn("⚠️ No orderId in session.metadata, skipping.");
        return res.json({ received: true });
      }

      // amount_total is in pence
      const paidAmount = Number(session.amount_total || 0) / 100;

      // Insert a payment record
      await pool.query(
        `INSERT INTO payments (order_id, amount, type, method, reference)
         VALUES ($1, $2, $3, $4, $5)`,
        [orderId, paidAmount, "full", "card", session.payment_intent]
      );

      // compute outstanding after this payment
      const { rows: orderRows } = await pool.query("SELECT * FROM orders WHERE id=$1", [orderId]);
      if (orderRows.length) {
        const order = orderRows[0];
        const { rows: paymentRows } = await pool.query("SELECT amount FROM payments WHERE order_id=$1", [orderId]);
        const paid = paymentRows.reduce((s, p) => s + Number(p.amount), 0);
        const total = Number(order.deposit || 0) + Number(order.balance || 0);
        const outstanding = Math.max(0, total - paid);

        // Email receipt to the customer, if we can infer their email
        const { rows: custRows } = await pool.query(
          "SELECT name, email FROM customers WHERE id=$1",
          [order.customer_id]
        );
        const cust = custRows[0];

        try {
          await sendEmail({
            to: cust?.email || process.env.TO_EMAIL || process.env.SMTP_USER,
            subject: `Payment Receipt — Order #${orderId}`,
            text: `Thank you for your payment of £${paidAmount.toFixed(2)} for Order #${orderId}.
            
Total: £${total.toFixed(2)}
Paid to date: £${paid.toFixed(2)}
Outstanding: £${outstanding.toFixed(2)}

If you have any questions, just reply to this email.

— PJH Web Services`,
          });
        } catch (e) {
          console.error("❌ Failed to send receipt email:", e.message);
        }

        // Optional: notify admin
        if (process.env.NOTIFY_ADMIN_ON_PAYMENT === "true") {
          try {
            await sendEmail({
              to: process.env.TO_EMAIL || process.env.SMTP_USER,
              subject: `Payment received — Order #${orderId}`,
              text: `£${paidAmount.toFixed(2)} received for Order #${orderId}.
Customer: ${cust?.name || "Unknown"} (${cust?.email || "no email"})
Outstanding now: £${outstanding.toFixed(2)}`,
            });
          } catch (e) {
            console.error("❌ Failed to notify admin:", e.message);
          }
        }
      }
    } catch (err) {
      console.error("❌ Error handling checkout.session.completed:", err);
      // still acknowledge receipt so Stripe doesn't retry forever
    }
  }

  return res.json({ received: true });
});

export default router;
