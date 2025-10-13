/**
 * ============================================================
 * PJH Web Services — Billing & Subscription API (2025)
 * ============================================================
 * Handles:
 *   ✅ Stripe Checkout (monthly build & maintenance)
 *   ✅ Direct Debit (BACS) + Card support
 *   ✅ Webhook listener for subscription & invoice events
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
   Start Stripe Checkout session for package/maintenance
============================================================ */
router.post("/checkout", async (req, res) => {
  try {
    const { orderId, customerId, packageId, maintenanceId } = req.body;

    if (!orderId || !customerId) {
      return res
        .status(400)
        .json({ error: "orderId and customerId are required" });
    }

    // ──────────────────────────────
    // Load customer
    // ──────────────────────────────
    const { rows: cRows } = await pool.query(
      "SELECT * FROM customers WHERE id=$1",
      [customerId]
    );
    const customer = cRows[0];
    if (!customer)
      return res.status(404).json({ error: "Customer not found" });

    // ──────────────────────────────
    // Ensure Stripe customer
    // ──────────────────────────────
    let stripeCustomerId = customer.stripe_customer_id;
    if (!stripeCustomerId) {
      const sc = await stripe.customers.create({
        email: customer.email,
        name: customer.business || customer.name,
        metadata: { customer_id: String(customerId) },
      });
      stripeCustomerId = sc.id;

      await pool.query(
        "UPDATE customers SET stripe_customer_id=$1 WHERE id=$2",
        [stripeCustomerId, customerId]
      );
    }

    // ──────────────────────────────
    // Build line items
    // ──────────────────────────────
    const line_items = [];

    if (packageId) {
      const { rows: pRows } = await pool.query(
        "SELECT name, stripe_price_id FROM packages WHERE id=$1 AND visible=TRUE",
        [packageId]
      );
      const pkg = pRows[0];
      if (!pkg?.stripe_price_id) {
        return res
          .status(400)
          .json({ error: "Package missing stripe_price_id" });
      }
      line_items.push({ price: pkg.stripe_price_id, quantity: 1 });
    }

    if (maintenanceId) {
      const { rows: mRows } = await pool.query(
        "SELECT name, stripe_price_id FROM maintenance_plans WHERE id=$1 AND visible=TRUE",
        [maintenanceId]
      );
      const plan = mRows[0];
      if (!plan?.stripe_price_id) {
        return res
          .status(400)
          .json({ error: "Maintenance plan missing stripe_price_id" });
      }
      line_items.push({ price: plan.stripe_price_id, quantity: 1 });
    }

    if (!line_items.length) {
      return res
        .status(400)
        .json({ error: "No subscription line items provided" });
    }

    // ──────────────────────────────
    // Create Stripe Checkout session
    // ──────────────────────────────
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: stripeCustomerId,
      payment_method_types: ["bacs_debit", "card"],
      line_items,
      success_url: `${FRONTEND_URL}/billing/success?order=${orderId}`,
      cancel_url: `${FRONTEND_URL}/billing/cancel?order=${orderId}`,
      subscription_data: {
        metadata: {
          pjh_customer_id: String(customerId),
          pjh_order_id: String(orderId),
          pjh_package_id: packageId ? String(packageId) : "",
          pjh_maintenance_id: maintenanceId ? String(maintenanceId) : "",
        },
      },
      metadata: {
        pjh_customer_id: String(customerId),
        pjh_order_id: String(orderId),
        pjh_package_id: packageId ? String(packageId) : "",
        pjh_maintenance_id: maintenanceId ? String(maintenanceId) : "",
      },
    });

    console.log(`✅ Checkout session created for order ${orderId}`);
    return res.json({ url: session.url });
  } catch (err) {
    console.error("❌ /api/billing/checkout failed:", err.message);
    res.status(500).json({ error: "Failed to start checkout" });
  }
});

/* ============================================================
   🧾 POST /api/billing/webhook
   Handles Stripe subscription, payment, and Direct Debit events
============================================================ */
router.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
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

    console.log(`🔔 Stripe Event Received: ${event.type}`);

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object;
          console.log(`✅ Checkout completed for session ${session.id}`);
          break;
        }

        case "customer.subscription.created": {
          const sub = event.data.object;
          console.log(
            `📦 Subscription created: ${sub.id} for customer ${sub.customer}`
          );
          break;
        }

        case "invoice.payment_succeeded": {
          const inv = event.data.object;
          console.log(
            `💰 Invoice paid: £${(inv.amount_paid / 100).toFixed(2)} — ${inv.id}`
          );
          break;
        }

        case "invoice.payment_failed": {
          const inv = event.data.object;
          console.log(`⚠️ Payment failed: ${inv.id}`);
          break;
        }

        case "customer.subscription.deleted": {
          const sub = event.data.object;
          console.log(`❌ Subscription canceled: ${sub.id}`);
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
  }
);

export default router;
