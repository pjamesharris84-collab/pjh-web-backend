// routes/stripeWebhook.js
import express from "express";
import Stripe from "stripe";
import pool from "../db.js";
import dotenv from "dotenv";

dotenv.config();
const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

router.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
      console.error("⚠️ Webhook signature verification failed:", err.message);
      return res.sendStatus(400);
    }

    try {
      if (event.type === "invoice.paid") {
        const invoice = event.data.object;

        const stripeCustomerId = invoice.customer;
        const amountPaid = invoice.amount_paid / 100; // pence → pounds
        const invoiceId = invoice.id;

        // Try to get identifiers from subscription metadata
        // (preferred – we set this in /billing/checkout)
        let pjh_customer_id = invoice?.subscription_details?.metadata?.pjh_customer_id;
        let pjh_order_id = invoice?.subscription_details?.metadata?.pjh_order_id;

        // Fallback: fetch subscription to read metadata
        if (!pjh_customer_id || !pjh_order_id) {
          const sub = await stripe.subscriptions.retrieve(invoice.subscription);
          pjh_customer_id = sub?.metadata?.pjh_customer_id;
          pjh_order_id = sub?.metadata?.pjh_order_id;
        }

        // Final fallback: map Stripe customer → our customer
        if (!pjh_customer_id) {
          const { rows: cRows } = await pool.query(
            "SELECT id FROM customers WHERE stripe_customer_id=$1 LIMIT 1",
            [stripeCustomerId]
          );
          pjh_customer_id = cRows[0]?.id;
        }

        // Record payment
        await pool.query(
          `
          INSERT INTO payments
            (order_id, customer_id, amount, type, method, status, reference, stripe_status, created_at)
          VALUES
            ($1, $2, $3, 'monthly', 'stripe', 'paid', $4, $5, NOW())
          ON CONFLICT DO NOTHING;
          `,
          [pjh_order_id || null, pjh_customer_id || null, amountPaid, invoiceId, invoice.status]
        );

        console.log(`✅ Recorded monthly payment £${amountPaid} for order ${pjh_order_id}`);
      }

      res.json({ received: true });
    } catch (err) {
      console.error("❌ Webhook handling error:", err.message);
      res.status(500).json({ error: "Webhook processing failed" });
    }
  }
);

export default router;
