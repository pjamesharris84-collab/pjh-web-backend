/**
 * ============================================================
 * PJH Web Services — Unified Billing & Subscription API (2025)
 * ============================================================
 * ✅ Stripe Checkout for Monthly Build & Maintenance
 * ✅ Direct Debit (BACS) or Card payments
 * ✅ Subscription and Invoice support
 * ✅ Webhook-driven status updates (processing / paid / failed)
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
const FRONTEND_URL = process.env.FRONTEND_URL || "https://www.pjhwebservices.co.uk";

/* ============================================================
   💳 POST /api/billing/checkout
   Creates a Stripe Checkout session for a package or plan
============================================================ */
router.post("/checkout", async (req, res) => {
  try {
    const { orderId, customerId, packageId, maintenanceId } = req.body;
    if (!orderId || !customerId)
      return res.status(400).json({ error: "orderId and customerId are required" });

    // 1️⃣ Fetch customer or create in Stripe
    const { rows: cRows } = await pool.query("SELECT * FROM customers WHERE id=$1", [customerId]);
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

    // 2️⃣ Build line items
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

    if (!line_items.length) return res.status(400).json({ error: "No valid line items" });

    // 3️⃣ Create checkout session
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: stripeCustomerId,
      payment_method_types: ["bacs_debit", "card"],
      line_items,
      success_url: `${FRONTEND_URL}/billing/success?order=${orderId}`,
      cancel_url: `${FRONTEND_URL}/billing/cancel?order=${orderId}`,
      subscription_data: {
        metadata: { order_id: String(orderId), customer_id: String(customerId) },
      },
      metadata: { order_id: String(orderId), customer_id: String(customerId) },
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
   Unified Webhook for Direct Debit + Payments + Subscriptions
============================================================ */
router.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
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
        /* ========================================================
           ✅ Checkout Session Completed (one-off payments)
        ========================================================= */
        case "checkout.session.completed": {
          const s = event.data.object;
          const orderId = s.metadata?.order_id;
          const paymentType = s.metadata?.payment_type || "deposit";
          const method = s.payment_method_types?.[0] || "card";
          const amount = (s.amount_total ?? 0) / 100;

          if (orderId && amount > 0) {
            await pool.query(
              `INSERT INTO payments (order_id, customer_id, amount, type, method, status, reference, created_at)
               SELECT id, customer_id, $1, $2, $3, 'paid', $4, NOW()
               FROM orders WHERE id=$5`,
              [amount, paymentType, method, s.payment_intent, orderId]
            );
            console.log(`💰 Payment logged: Order #${orderId} — £${amount}`);
          }
          break;
        }

        /* ========================================================
           🏦 Direct Debit Mandate Setup Completed
        ========================================================= */
        case "setup_intent.succeeded": {
          const si = event.data.object;
          const mandate = si.mandate || null;
          const paymentMethod = si.payment_method || null;
          const customerId = si.customer;

          if (customerId) {
            await pool.query(
              `UPDATE customers 
               SET stripe_mandate_id=$1, stripe_payment_method_id=$2, direct_debit_active=true 
               WHERE stripe_customer_id=$3`,
              [mandate, paymentMethod, customerId]
            );
            console.log(`🏦 Direct Debit setup complete — ${customerId}`);
          }
          break;
        }

        /* ========================================================
           💸 Direct Debit / Recurring Payments
           Includes processing → succeeded → failed
        ========================================================= */
        case "payment_intent.processing": {
          const pi = event.data.object;
          const orderId = pi.metadata?.order_id;
          const amount = (pi.amount || 0) / 100;

          if (orderId) {
            await pool.query(
              `INSERT INTO payments (order_id, customer_id, amount, type, method, status, reference, created_at)
               SELECT id, customer_id, $2, 'maintenance', 'bacs', 'processing', $3, NOW()
               FROM orders WHERE id=$1
               ON CONFLICT (reference) DO UPDATE SET status='processing';`,
              [orderId, amount, pi.id]
            );
            console.log(`🕓 Direct Debit processing: Order #${orderId} — £${amount}`);
          }
          break;
        }

        case "payment_intent.succeeded": {
          const pi = event.data.object;
          const orderId = pi.metadata?.order_id;
          const amount = (pi.amount_received || pi.amount || 0) / 100;

          if (orderId) {
            await pool.query(
              `UPDATE payments SET status='paid', amount=$2 WHERE reference=$1;
               INSERT INTO payments (order_id, customer_id, amount, type, method, status, reference, created_at)
               SELECT id, customer_id, $2, 'maintenance', 'bacs', 'paid', $1, NOW()
               FROM orders WHERE id=$3
               ON CONFLICT (reference) DO NOTHING;`,
              [pi.id, amount, orderId]
            );
            console.log(`✅ Direct Debit succeeded: Order #${orderId} — £${amount}`);
          }
          break;
        }

        case "payment_intent.payment_failed": {
          const pi = event.data.object;
          const orderId = pi.metadata?.order_id;
          if (orderId && pi.id) {
            await pool.query("UPDATE payments SET status='failed' WHERE reference=$1", [pi.id]);
            console.log(`❌ Direct Debit failed: Order #${orderId}`);
          }
          break;
        }

        /* ========================================================
           🧾 Invoices & Subscriptions
        ========================================================= */
        case "invoice.payment_succeeded": {
          const inv = event.data.object;
          console.log(`💰 Invoice paid: £${(inv.amount_paid || 0) / 100}`);
          break;
        }

        case "invoice.payment_failed": {
          const inv = event.data.object;
          console.log(`⚠️ Invoice failed: ${inv.id}`);
          break;
        }

        case "customer.subscription.created": {
          const sub = event.data.object;
          console.log(`📦 Subscription created: ${sub.id}`);
          break;
        }

        case "customer.subscription.deleted": {
          const sub = event.data.object;
          console.log(`❌ Subscription canceled: ${sub.id}`);
          break;
        }

        /* ========================================================
           Default / Unhandled
        ========================================================= */
        default:
          console.log(`ℹ️ Unhandled Stripe event: ${event.type}`);
      }

      res.status(200).json({ received: true });
    } catch (err) {
      console.error("❌ Webhook handler failed:", err);
      res.status(500).send("Webhook processing failed");
    }
  }
);

export default router;
