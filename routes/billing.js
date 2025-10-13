/**
 * ============================================================
 * PJH Web Services — Billing & Subscription API (2025)
 * ============================================================
 * ✅ Monthly build & maintenance via Stripe Subscription
 * ✅ Direct Debit (BACS) or Card supported
 * ✅ Webhook listener for invoices/subscriptions
 * ============================================================
 */

import express from "express";
import pool from "../db.js";
import Stripe from "stripe";
import dotenv from "dotenv";
import bodyParser from "body-parser";

dotenv.config();

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const FRONTEND_URL =
  process.env.FRONTEND_URL || "https://www.pjhwebservices.co.uk";

/* ============================================================
   💳 POST /api/billing/checkout
============================================================ */
router.post("/checkout", async (req, res) => {
  try {
    const { orderId, customerId, packageId, maintenanceId } = req.body;
    if (!orderId || !customerId)
      return res.status(400).json({ error: "orderId and customerId are required" });

    const { rows: cRows } = await pool.query("SELECT * FROM customers WHERE id=$1", [
      customerId,
    ]);
    const customer = cRows[0];
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    let stripeCustomerId = customer.stripe_customer_id;
    if (!stripeCustomerId) {
      const sc = await stripe.customers.create({
        email: customer.email,
        name: customer.business || customer.name,
        metadata: { customer_id: String(customerId) },
      });
      stripeCustomerId = sc.id;
      await pool.query("UPDATE customers SET stripe_customer_id=$1 WHERE id=$2", [
        stripeCustomerId,
        customerId,
      ]);
    }

    const line_items = [];
    if (packageId) {
      const { rows: pRows } = await pool.query(
        "SELECT name, stripe_price_id FROM packages WHERE id=$1 AND visible=TRUE",
        [packageId]
      );
      if (!pRows[0]?.stripe_price_id)
        return res.status(400).json({ error: "Invalid package" });
      line_items.push({ price: pRows[0].stripe_price_id, quantity: 1 });
    }
    if (maintenanceId) {
      const { rows: mRows } = await pool.query(
        "SELECT name, stripe_price_id FROM maintenance_plans WHERE id=$1 AND visible=TRUE",
        [maintenanceId]
      );
      if (!mRows[0]?.stripe_price_id)
        return res.status(400).json({ error: "Invalid maintenance plan" });
      line_items.push({ price: mRows[0].stripe_price_id, quantity: 1 });
    }
    if (!line_items.length)
      return res.status(400).json({ error: "No valid line items" });

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: stripeCustomerId,
      payment_method_types: ["bacs_debit", "card"],
      line_items,
      success_url: `${FRONTEND_URL}/billing/success?order=${orderId}`,
      cancel_url: `${FRONTEND_URL}/billing/cancel?order=${orderId}`,
      subscription_data: {
        metadata: {
          pjh_order_id: String(orderId),
          pjh_customer_id: String(customerId),
        },
      },
      metadata: {
        pjh_order_id: String(orderId),
        pjh_customer_id: String(customerId),
      },
    });

    console.log(`✅ Checkout session created for order ${orderId}`);
    res.json({ success: true, url: session.url });
  } catch (err) {
    console.error("❌ /api/billing/checkout failed:", err);
    res.status(500).json({ error: "Failed to start checkout" });
  }
});

/* ============================================================
   🧾 POST /api/billing/webhook
============================================================ */
router.post("/webhook", bodyParser.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`🔔 Stripe Event Received: ${event.type}`);

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        console.log(`✅ Checkout completed: ${event.data.object.id}`);
        break;
      }
      case "customer.subscription.created": {
        const s = event.data.object;
        console.log(`📦 Subscription created: ${s.id} for ${s.customer}`);
        break;
      }
      case "invoice.payment_succeeded": {
        const inv = event.data.object;
        const amount = (inv.amount_paid / 100).toFixed(2);
        console.log(`💰 Invoice paid: £${amount} (${inv.id})`);
        break;
      }
      case "invoice.payment_failed": {
        const inv = event.data.object;
        console.log(`⚠️ Invoice failed: ${inv.id}`);
        break;
      }
      case "customer.subscription.deleted": {
        const s = event.data.object;
        console.log(`❌ Subscription canceled: ${s.id}`);
        break;
      }
      default:
        console.log(`ℹ️ Unhandled Stripe event: ${event.type}`);
    }

    res.status(200).send("ok");
  } catch (err) {
    console.error("❌ Webhook handler failed:", err);
    res.status(500).send("Webhook processing failed");
  }
});

export default router;
