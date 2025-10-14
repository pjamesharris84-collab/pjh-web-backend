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
   Unified Webhook for Payments + Direct Debit + Subscriptions
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
        /* ========================================================
           ✅ One-off Payments via Checkout (Card/Bacs)
        ========================================================= */
        case "checkout.session.completed": {
          const s = event.data.object;
          const orderId = s.metadata?.order_id;
          const paymentType = s.metadata?.payment_type || "deposit";
          const method = s.payment_method_types?.[0] || "card";
          const amount = (s.amount_total ?? 0) / 100;

          if (orderId && amount > 0) {
            await pool.query(
              `
              INSERT INTO payments (order_id, customer_id, amount, type, method, status, reference, created_at)
              SELECT id, customer_id, $1, $2, $3, 'paid', $4, NOW()
              FROM orders WHERE id=$5
              `,
              [amount, paymentType, method, s.payment_intent, orderId]
            );
            console.log(`💰 Payment logged: Order #${orderId} — £${amount}`);
          }
          break;
        }

        /* ========================================================
           🏦 Direct Debit Setup Complete
        ========================================================= */
        case "setup_intent.succeeded": {
          const si = event.data.object;
          const paymentMethod = si.payment_method || null;
          const mandate = si.mandate || null;
          const customer = si.customer;

          if (customer) {
            await pool.query(
              `UPDATE customers 
               SET stripe_mandate_id=$1, stripe_payment_method_id=$2, direct_debit_active=true 
               WHERE stripe_customer_id=$3`,
              [mandate, paymentMethod, customer]
            );
            console.log(`🏦 Direct Debit setup complete for ${customer}`);
          }
          break;
        }

        /* ========================================================
           💸 Direct Debit or Recurring Charge (Maintenance)
        ========================================================= */
        case "payment_intent.succeeded": {
          const pi = event.data.object;
          const amount = (pi.amount_received || pi.amount || 0) / 100;
          const orderId = pi.metadata?.order_id;
          const type = pi.metadata?.payment_type || "maintenance";

          if (orderId && amount > 0) {
            const { rowCount } = await pool.query(
              "UPDATE payments SET status='paid' WHERE reference=$1",
              [pi.id]
            );
            if (!rowCount) {
              await pool.query(
                `
                INSERT INTO payments (order_id, customer_id, amount, type, method, status, reference, created_at)
                SELECT id, customer_id, $1, $2, 'bacs', 'paid', $3, NOW()
                FROM orders WHERE id=$4
                `,
                [amount, type, pi.id, orderId]
              );
            }
            console.log(`🏁 Bacs/Direct Debit charge success: Order #${orderId} — £${amount}`);
          }
          break;
        }

        /* ========================================================
           ⚠️ Payment Failed
        ========================================================= */
        case "payment_intent.payment_failed": {
          const pi = event.data.object;
          await pool.query(
            "UPDATE payments SET status='failed' WHERE reference=$1",
            [pi.id]
          );
          console.log(`❌ Payment failed: ${pi.id}`);
          break;
        }

        /* ========================================================
           🧾 Invoice or Subscription Events
        ========================================================= */
        case "invoice.payment_succeeded": {
          const inv = event.data.object;
          const amount = (inv.amount_paid || 0) / 100;
          const subId = inv.subscription;
          console.log(`💰 Invoice paid: £${amount} (sub: ${subId})`);
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
           (Default)
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
