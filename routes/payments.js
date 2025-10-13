/**
 * ============================================================
 * PJH Web Services — Stripe Payments & Billing (Unified 2025)
 * ============================================================
 * ✅ Card & Bacs one-off payments
 * ✅ Direct Debit setup (mode: "setup")
 * ✅ Webhook reconciliation (raw body safe)
 * ✅ Refund endpoint (recharge-friendly)
 * ✅ Payments summary endpoint for Admin UI
 * ============================================================
 */

import express from "express";
import Stripe from "stripe";
import dotenv from "dotenv";
import pool from "../db.js";
import bodyParser from "body-parser";
import { sendEmail } from "../utils/email.js";
import { paymentRequestTemplate } from "../utils/emailTemplates.js";

dotenv.config();
const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const FRONTEND_URL =
  process.env.FRONTEND_URL ||
  (process.env.NODE_ENV === "development"
    ? "http://localhost:5173"
    : "https://www.pjhwebservices.co.uk");

/* ============================================================
   🧮 Helpers
============================================================ */
function toNum(v, f = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : f;
}

/* ============================================================
   📊 GET /api/payments/summary/:orderId
   → For Admin UI “Payments” tab: shows outstanding amounts
============================================================ */
router.get("/summary/:orderId", async (req, res) => {
  try {
    const orderId = req.params.orderId;

    const { rows: orows } = await pool.query(
      `SELECT o.id, o.title, o.deposit, o.balance, o.customer_id,
              c.name AS customer_name, c.email, c.direct_debit_active, c.stripe_mandate_id,
              o.maintenance_id
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       WHERE o.id=$1`,
      [orderId]
    );
    if (!orows.length) return res.status(404).json({ error: "Order not found" });

    const order = orows[0];

    // deposit outstanding
    const { rows: dep } = await pool.query(
      `
      SELECT
        COALESCE(SUM(CASE WHEN status='paid' THEN amount ELSE 0 END),0)::numeric AS paid_total,
        COALESCE(SUM(CASE WHEN status='refunded' THEN amount ELSE 0 END),0)::numeric AS refunded_total
      FROM payments
      WHERE order_id=$1 AND (type='deposit' OR type='refund')`,
      [orderId]
    );
    const depPaid = toNum(dep[0]?.paid_total);
    const depRefundedAbs = Math.abs(toNum(dep[0]?.refunded_total));
    const depNet = Math.max(depPaid - depRefundedAbs, 0);
    const depositOutstanding = Math.max(toNum(order.deposit) - depNet, 0);

    // balance outstanding
    const { rows: bal } = await pool.query(
      `
      SELECT
        COALESCE(SUM(CASE WHEN status='paid' THEN amount ELSE 0 END),0)::numeric AS paid_total,
        COALESCE(SUM(CASE WHEN status='refunded' THEN amount ELSE 0 END),0)::numeric AS refunded_total
      FROM payments
      WHERE order_id=$1 AND (type='balance' OR type='refund')`,
      [orderId]
    );
    const balPaid = toNum(bal[0]?.paid_total);
    const balRefundedAbs = Math.abs(toNum(bal[0]?.refunded_total));
    const balNet = Math.max(balPaid - balRefundedAbs, 0);
    const balanceOutstanding = Math.max(toNum(order.balance) - balNet, 0);

    // maintenance monthly (for display)
    const { rows: maint } = await pool.query(
      `SELECT price FROM maintenance_plans WHERE id = (
         SELECT maintenance_id FROM orders WHERE id=$1
       )`,
      [orderId]
    );
    const maintenanceMonthly = toNum(maint?.[0]?.price, 0);

    return res.json({
      success: true,
      data: {
        order_id: order.id,
        title: order.title,
        deposit: toNum(order.deposit),
        balance: toNum(order.balance),
        deposit_outstanding: depositOutstanding,
        balance_outstanding: balanceOutstanding,
        maintenance_monthly: maintenanceMonthly,
        direct_debit_active: !!order.direct_debit_active,
        mandate_id: order.stripe_mandate_id || null,
      },
    });
  } catch (err) {
    console.error("❌ payments summary error:", err);
    res.status(500).json({ error: "Failed to build payments summary" });
  }
});

/* ============================================================
   💳 POST /api/payments/create-checkout
   → Creates Stripe Checkout for deposit, balance or DD setup
============================================================ */
router.post("/create-checkout", async (req, res) => {
  try {
    const { orderId, flow, type } = req.body;
    if (!orderId) return res.status(400).json({ error: "Missing orderId" });
    if (flow !== "bacs_setup" && !type)
      return res.status(400).json({ error: "Missing type (deposit|balance)" });

    // 1️⃣ Get order + customer
    const { rows } = await pool.query(
      `SELECT o.*, 
              c.id AS cid, c.name AS customer_name, c.email,
              c.stripe_customer_id, c.stripe_mandate_id, c.direct_debit_active
       FROM orders o 
       JOIN customers c ON c.id = o.customer_id 
       WHERE o.id = $1`,
      [orderId]
    );
    if (!rows.length) return res.status(404).json({ error: "Order not found" });

    const order = rows[0];

    // 2️⃣ Base amount (allow explicit override from UI)
    const baseAmount =
      req.body.amount ??
      (type === "deposit" ? toNum(order.deposit) : toNum(order.balance));

    // 3️⃣ Net paid for this type (refunds reduce)
    const { rows: summary } = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN status='paid' THEN amount ELSE 0 END),0)::numeric AS paid_total,
         COALESCE(SUM(CASE WHEN status='refunded' THEN amount ELSE 0 END),0)::numeric AS refunded_total
       FROM payments WHERE order_id=$1 AND (type=$2 OR type='refund')`,
      [order.id, type || "deposit"]
    );
    const paidTotal = toNum(summary[0]?.paid_total);
    const refundedTotalAbs = Math.abs(toNum(summary[0]?.refunded_total));
    const netPaid = Math.max(paidTotal - refundedTotalAbs, 0);
    const amount = Math.max(baseAmount - netPaid, 0);

    if (flow !== "bacs_setup" && amount <= 0) {
      return res.status(400).json({
        error: `No outstanding ${type} amount — already paid or refunded.`,
        amount,
      });
    }

    // 4️⃣ Ensure Stripe customer
    const stripeCustomer =
      order.stripe_customer_id ||
      (await stripe.customers
        .create({
          name: order.customer_name,
          email: order.email,
          metadata: { order_id: orderId },
        })
        .then((c) => {
          pool
            .query("UPDATE customers SET stripe_customer_id=$1 WHERE id=$2", [
              c.id,
              order.customer_id,
            ])
            .catch(() => {});
          return c.id;
        }));

    // 5️⃣ Determine mode + method types
    const mode = flow === "bacs_setup" ? "setup" : "payment";
    const paymentMethodTypes =
      flow === "bacs_payment" || flow === "bacs_setup" ? ["bacs_debit"] : ["card"];

    console.log("💳 Stripe checkout request:", {
      orderId,
      flow,
      type,
      mode,
      amount,
      paymentMethodTypes,
    });

    // 6️⃣ Create Checkout Session
    const session = await stripe.checkout.sessions.create({
      mode,
      customer: stripeCustomer,
      payment_method_types: paymentMethodTypes,
      ...(mode === "setup"
        ? {}
        : {
            line_items: [
              {
                price_data: {
                  currency: "gbp",
                  product_data: { name: `${type} — ${order.title}` },
                  unit_amount: Math.round(amount * 100),
                },
                quantity: 1,
              },
            ],
          }),
      success_url: `${FRONTEND_URL}/payment-success?order=${order.id}`,
      cancel_url: `${FRONTEND_URL}/payment-cancelled?order=${order.id}`,
      metadata: {
        order_id: String(order.id),
        payment_type: type || "setup",
      },
    });

    // 7️⃣ Email link (optional but helpful)
    await sendEmail({
      to: order.email,
      subject: `Secure ${type || "Direct Debit"} payment — ${order.title}`,
      html: paymentRequestTemplate({
        customerName: order.customer_name,
        orderTitle: order.title,
        amount: mode === "setup" ? 0 : amount,
        link: session.url,
        type: type || "setup",
      }),
    });

    console.log(`✅ Stripe session created for order #${order.id} (${flow})`);
    // Include computed amount so the UI can display exactly what will be charged
    res.json({ success: true, url: session.url, amount: mode === "setup" ? 0 : amount });
  } catch (err) {
    console.error("❌ create-checkout error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   💸 POST /api/payments/refund
============================================================ */
router.post("/refund", async (req, res) => {
  const { payment_id, amount } = req.body;
  if (!payment_id || !amount)
    return res.status(400).json({ error: "Missing payment_id or amount" });

  try {
    const { rows } = await pool.query("SELECT * FROM payments WHERE id=$1", [
      payment_id,
    ]);
    if (!rows.length) return res.status(404).json({ error: "Payment not found" });
    const payment = rows[0];

    if (!payment.reference) {
      return res
        .status(400)
        .json({ error: "Original payment has no Stripe reference." });
    }

    const refund = await stripe.refunds.create({
      payment_intent: payment.reference,
      amount: Math.round(Math.abs(Number(amount)) * 100),
      reason: "requested_by_customer",
    });

    await pool.query(
      `INSERT INTO payments (order_id, customer_id, amount, type, method, status, reference)
       VALUES ($1,$2,$3,'refund',$4,'refunded',$5)`,
      [
        payment.order_id,
        payment.customer_id,
        -Math.abs(Number(amount)),
        payment.method || "card",
        refund.id,
      ]
    );

    console.log(`💸 Refund recorded for order ${payment.order_id} (£${Number(amount).toFixed(2)})`);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Refund error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   ⚡ POST /api/payments/webhook — Stripe Webhook Handler
   NOTE: Keep this route before any global express.json()
         and use bodyParser.raw to preserve signature
============================================================ */
router.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body, // RAW BUFFER
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("❌ Webhook signature failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      switch (event.type) {
        // ✅ Checkout page completed (card or bacs)
        case "checkout.session.completed": {
          const session = event.data.object;
          const orderId = session.metadata?.order_id;
          const paymentType = session.metadata?.payment_type || "deposit";
          const method =
            (Array.isArray(session.payment_method_types) &&
              session.payment_method_types[0]) ||
            "card";
          const amount =
            typeof session.amount_total === "number"
              ? session.amount_total / 100
              : 0;

          if (orderId && amount > 0) {
            await pool.query(
              `INSERT INTO payments (order_id, customer_id, amount, type, method, status, reference)
               SELECT id, customer_id, $1, $2, $3, 'paid', $4 FROM orders WHERE id=$5`,
              [amount, paymentType, method, session.payment_intent, orderId]
            );
            console.log(`💰 Recorded payment: Order #${orderId} — £${amount} [${paymentType}]`);
          }
          break;
        }

        // ✅ Direct Debit setup
        case "setup_intent.succeeded": {
          const setup = event.data.object;
          const customer = setup.customer;
          const mandate = setup.mandate;
          await pool.query(
            "UPDATE customers SET stripe_mandate_id=$1, direct_debit_active=true WHERE stripe_customer_id=$2",
            [mandate, customer]
          );
          console.log(`🏦 Direct Debit setup complete for customer ${customer}`);
          break;
        }

        // ✅ Off-session Bacs attempt succeeded (e.g., monthly maintenance)
        case "payment_intent.succeeded": {
          const pi = event.data.object;
          const amount = (pi.amount_received || pi.amount || 0) / 100;
          const orderId = pi.metadata?.order_id;
          const paymentType = pi.metadata?.payment_type || "maintenance";
          if (orderId && amount > 0) {
            // If a row exists for this reference in 'processing', upgrade to paid; else insert
            const { rowCount } = await pool.query(
              "UPDATE payments SET status='paid' WHERE reference=$1",
              [pi.id]
            );
            if (!rowCount) {
              await pool.query(
                `INSERT INTO payments (order_id, customer_id, amount, type, method, status, reference)
                 SELECT id, customer_id, $1, $2, 'bacs', 'paid', $3 FROM orders WHERE id=$4`,
                [amount, paymentType, pi.id, orderId]
              );
            }
            console.log(`🏁 Bacs Debit paid: Order #${orderId} — £${amount} [${paymentType}]`);
          }
          break;
        }

        // ❌ Off-session Bacs failed
        case "payment_intent.payment_failed": {
          const pi = event.data.object;
          await pool.query(
            "UPDATE payments SET status='failed' WHERE reference=$1",
            [pi.id]
          );
          console.log(`❌ Bacs Debit failed: ${pi.id}`);
          break;
        }

        default:
          console.log(`ℹ️ Unhandled event type: ${event.type}`);
      }

      res.json({ received: true });
    } catch (err) {
      console.error("❌ Webhook handler error:", err);
      res.status(500).send("Webhook handler error");
    }
  }
);

export default router;
