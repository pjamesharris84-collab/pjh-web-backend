/**
 * ============================================================
 * PJH Web Services — Billing & Subscription API (2025)
 * ============================================================
 * ✅ Monthly build & maintenance via Stripe Subscription
 * ✅ Direct Debit (BACS) or Card supported
 * ✅ Unified webhook (invoices / subscriptions / DD intents)
 * ✅ Idempotent payment logging (processing → paid/failed)
 * ✅ Auto-populates customer Stripe IDs (customer/PM/mandate)
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

/* ------------------------------------------------------------
   Helpers
------------------------------------------------------------ */
function poundsFromCents(n) {
  return (Number(n ?? 0) / 100);
}

async function upsertPaymentByReference({
  reference,            // Stripe PI id or CSI id
  orderId,              // PJH order id (int)
  amount,               // pounds (number)
  type,                 // 'deposit' | 'balance' | 'maintenance' | 'subscription' | ...
  method,               // 'card' | 'bacs' | ...
  status,               // 'processing' | 'paid' | 'failed' | 'refunded'
}) {
  if (!reference) return;

  // 1) Try to update existing row by reference (handles retries / state changes)
  const updateRes = await pool.query(
    `UPDATE payments
       SET status = $1,
           amount = COALESCE($2, amount),
           type   = COALESCE($3, type),
           method = COALESCE($4, method)
     WHERE reference = $5`,
    [status, amount ?? null, type ?? null, method ?? null, reference]
  );

  if (updateRes.rowCount > 0) return; // done

  // 2) If no row updated, insert a new one, deriving customer_id from orders
  // (Single statement; no trailing semicolons)
  try {
    await pool.query(
      `INSERT INTO payments
        (order_id, customer_id, amount, type, method, status, reference, created_at)
       SELECT id, customer_id, $1, $2, $3, $4, $5, NOW()
       FROM orders WHERE id = $6`,
      [amount ?? 0, type ?? "maintenance", method ?? "bacs", status, reference, orderId]
    );
  } catch (e) {
    // If a unique (reference) constraint exists and a race occurs, ignore duplicate
    if (e?.code === "23505") {
      return;
    }
    throw e;
  }
}

async function ensureStripeCustomerId(customerId) {
  const { rows } = await pool.query(`SELECT * FROM customers WHERE id=$1`, [customerId]);
  const c = rows[0];
  if (!c) return null;

  if (c.stripe_customer_id) return c.stripe_customer_id;

  const sc = await stripe.customers.create({
    email: c.email,
    name: c.business || c.name,
    metadata: { customer_id: String(customerId) },
  });

  await pool.query(
    `UPDATE customers SET stripe_customer_id=$1 WHERE id=$2`,
    [sc.id, customerId]
  );

  return sc.id;
}

/* ============================================================
   💳 POST /api/billing/checkout
   Create a Stripe Checkout (subscription) session
============================================================ */
router.post("/checkout", async (req, res) => {
  try {
    const { orderId, customerId, packageId, maintenanceId } = req.body;
    if (!orderId || !customerId) {
      return res.status(400).json({ error: "orderId and customerId are required" });
    }

    const stripeCustomerId = await ensureStripeCustomerId(customerId);
    if (!stripeCustomerId) {
      return res.status(404).json({ error: "Customer not found" });
    }

    const line_items = [];

    if (packageId) {
      const { rows } = await pool.query(
        `SELECT name, stripe_price_id FROM packages WHERE id=$1 AND visible=TRUE`,
        [packageId]
      );
      const price = rows?.[0]?.stripe_price_id;
      if (!price) return res.status(400).json({ error: "Invalid package" });
      line_items.push({ price, quantity: 1 });
    }

    if (maintenanceId) {
      const { rows } = await pool.query(
        `SELECT name, stripe_price_id FROM maintenance_plans WHERE id=$1 AND visible=TRUE`,
        [maintenanceId]
      );
      const price = rows?.[0]?.stripe_price_id;
      if (!price) return res.status(400).json({ error: "Invalid maintenance plan" });
      line_items.push({ price, quantity: 1 });
    }

    if (!line_items.length) {
      return res.status(400).json({ error: "No valid line items" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: stripeCustomerId,
      payment_method_types: ["bacs_debit", "card"],
      line_items,
      success_url: `${FRONTEND_URL}/billing/success?order=${orderId}`,
      cancel_url: `${FRONTEND_URL}/billing/cancel?order=${orderId}`,
      client_reference_id: String(orderId),
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
   Unified Webhook — Payments + Direct Debit + Subscriptions
   (Mount with raw body in server BEFORE express.json())
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
        /* --------------------------------------------------------
           ✅ One-off Payments via Checkout (Card/BACS)
           (If you still create one-off Checkout sessions elsewhere)
        --------------------------------------------------------- */
        case "checkout.session.completed": {
          const s = event.data.object;
          const orderId = Number(s.metadata?.order_id || s.metadata?.pjh_order_id);
          const paymentType = s.metadata?.payment_type || "deposit";
          const method = (s.payment_method_types?.[0] || "card").toLowerCase();
          const amount = poundsFromCents(s.amount_total ?? 0);
          const reference = s.payment_intent || s.id;

          if (orderId && amount > 0 && reference) {
            await upsertPaymentByReference({
              reference,
              orderId,
              amount,
              type: paymentType,
              method,
              status: "paid",
            });
            console.log(`💰 Payment logged: Order #${orderId} — £${amount.toFixed(2)}`);
          }
          break;
        }

        /* --------------------------------------------------------
           🏦 Direct Debit Setup Complete (BACS)
           - Persist PM + Mandate + set active flag
        --------------------------------------------------------- */
        case "setup_intent.succeeded": {
          const si = event.data.object;
          const paymentMethodId = si.payment_method || null;
          let mandateId = si.mandate || null;
          const stripeCustomerId = si.customer;

          // Try to retrieve mandate from the PaymentMethod if missing
          if (!mandateId && paymentMethodId) {
            try {
              const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
              mandateId = pm?.bacs_debit?.mandate || mandateId || null;
            } catch {
              // Ignore retrieve errors here; we still store PM
            }
          }

          if (stripeCustomerId) {
            await pool.query(
              `UPDATE customers 
                 SET stripe_mandate_id=$1,
                     stripe_payment_method_id=$2,
                     direct_debit_active=true
               WHERE stripe_customer_id=$3`,
              [mandateId, paymentMethodId, stripeCustomerId]
            );
            console.log(`🏦 Direct Debit setup stored — customer ${stripeCustomerId}`);
          }
          break;
        }

        /* --------------------------------------------------------
           💸 Direct Debit / Maintenance charge lifecycle
           (automation creates PI with metadata: order_id, type=maintenance)
        --------------------------------------------------------- */
        case "payment_intent.processing": {
          const pi = event.data.object;
          const amount = poundsFromCents(pi.amount || 0);
          const orderId = Number(pi.metadata?.order_id || pi.metadata?.pjh_order_id);
          const type = (pi.metadata?.payment_type || pi.metadata?.type || "maintenance").toLowerCase();
          const method = (pi.payment_method_types?.[0] || "bacs").toLowerCase();
          const reference = pi.id;

          if (orderId && reference) {
            await upsertPaymentByReference({
              reference,
              orderId,
              amount,
              type,
              method,
              status: "processing",
            });
            console.log(`⏳ Payment processing: Order #${orderId} — £${amount.toFixed(2)}`);
          }
          break;
        }

        case "payment_intent.succeeded": {
          const pi = event.data.object;
          const amount = poundsFromCents(pi.amount_received || pi.amount || 0);
          const orderId = Number(pi.metadata?.order_id || pi.metadata?.pjh_order_id);
          const type = (pi.metadata?.payment_type || pi.metadata?.type || "maintenance").toLowerCase();
          const method = (pi.payment_method_types?.[0] || "bacs").toLowerCase();
          const reference = pi.id;

          if (orderId && reference) {
await upsertPaymentByReference({
  order_id,
  customer_id,
  amount,
  type,
  method,
  reference: paymentIntent.id,
  stripe_charge_id: charge?.id || event.data.object.charge || null,
  status: "paid",
  source: "stripe",
});

            console.log(`🏁 Payment succeeded: Order #${orderId} — £${amount.toFixed(2)}`);
          }
          break;
        }

        case "payment_intent.payment_failed": {
          const pi = event.data.object;
          const amount = poundsFromCents(pi.amount || 0);
          const orderId = Number(pi.metadata?.order_id || pi.metadata?.pjh_order_id);
          const type = (pi.metadata?.payment_type || pi.metadata?.type || "maintenance").toLowerCase();
          const method = (pi.payment_method_types?.[0] || "bacs").toLowerCase();
          const reference = pi.id;

          if (orderId && reference) {
            await upsertPaymentByReference({
              reference,
              orderId,
              amount,
              type,
              method,
              status: "failed",
            });
            console.log(`❌ Payment failed: Order #${orderId}`);
          }
          break;
        }

        /* --------------------------------------------------------
           🧾 Invoices / Subscriptions (informational for now)
        --------------------------------------------------------- */
        case "invoice.payment_succeeded": {
          const inv = event.data.object;
          const amount = poundsFromCents(inv.amount_paid || 0);
          const subId = inv.subscription;
          console.log(`💰 Invoice paid: £${amount.toFixed(2)} (sub: ${subId})`);
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

        /* --------------------------------------------------------
           Default
        --------------------------------------------------------- */
        default:
          console.log(`ℹ️ Unhandled Stripe event: ${event.type}`);
      }

      // Always 200 back to Stripe after successful handling
      res.status(200).json({ received: true });
    } catch (err) {
      console.error("❌ Webhook handler failed:", err);
      res.status(500).send("Webhook processing failed");
    }
  }
);

export default router;
