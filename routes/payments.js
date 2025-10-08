/**
 * ============================================================
 * PJH Web Services — Unified Stripe Payments & Direct Debit API
 * ============================================================
 * Handles:
 *  - Card payments (deposit/balance)
 *  - Direct Debit setup (BACS)
 *  - Stripe webhooks for reconciliation and receipts
 *  - Automatic email notifications
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
import { LOGO_BASE64 } from "../utils/emailLogo.js";

dotenv.config();

const router = express.Router();

// ✅ Let Stripe auto-select your account’s API version (no manual pin)
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// 🧭 Log API version for clarity
(async () => {
  try {
    const info = await stripe.accounts.retrieve();
    console.log(
      `🔗 Stripe connected (API version: ${stripe.getApiField("version") || "default"})`
    );
  } catch {
    console.log("🔗 Stripe initialized (version auto-detected)");
  }
})();

const FRONTEND_URL =
  process.env.FRONTEND_URL ||
  (process.env.NODE_ENV === "development"
    ? "http://localhost:5173"
    : "https://www.pjhwebservices.co.uk");

/* ============================================================
   💳 1️⃣ Create Stripe Card Payment Session
============================================================ */
router.post("/create-session", async (req, res) => {
  const { orderId, type } = req.body;

  if (!orderId || !["deposit", "balance"].includes(type)) {
    return res.status(400).json({
      success: false,
      error: "Invalid orderId or payment type.",
    });
  }

  try {
    const { rows } = await pool.query(
      `
      SELECT o.*, c.name, c.email, c.business
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      WHERE o.id = $1;
      `,
      [orderId]
    );

    if (!rows.length)
      return res.status(404).json({ success: false, error: "Order not found." });

    const order = rows[0];
    const amount = type === "deposit" ? Number(order.deposit) : Number(order.balance);

    if (isNaN(amount) || amount <= 0)
      return res.status(400).json({ success: false, error: "Invalid amount." });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "gbp",
            product_data: {
              name: `${type === "deposit" ? "Deposit" : "Balance"} — ${order.title}`,
            },
            unit_amount: Math.round(amount * 100),
          },
          quantity: 1,
        },
      ],
      metadata: {
        order_id: order.id,
        customer_id: order.customer_id,
        payment_type: type,
      },
      success_url: `${FRONTEND_URL}/payment-success?order=${order.id}`,
      cancel_url: `${FRONTEND_URL}/payment-cancelled?order=${order.id}`,
      customer_email: order.email,
    });

    // 💌 Email payment link to customer
    await sendEmail({
      to: order.email,
      subject: `Secure ${type} payment link — ${order.title}`,
      html: paymentRequestTemplate({
        customerName: order.name,
        orderTitle: order.title,
        amount,
        link: session.url,
        type,
      }),
    });

    res.json({ success: true, url: session.url });
  } catch (err) {
    console.error("❌ Error creating Stripe session:", err);
    res.status(500).json({ success: false, error: "Failed to create payment session." });
  }
});

/* ============================================================
   🧾 2️⃣ Setup Direct Debit Mandate (Stripe BACS – Hosted Flow)
============================================================ */
router.post("/setup-direct-debit/:customerId", async (req, res) => {
  try {
    const { customerId } = req.params;
    const { rows } = await pool.query("SELECT * FROM customers WHERE id=$1", [customerId]);

    if (!rows.length)
      return res.status(404).json({ success: false, error: "Customer not found." });

    const customer = rows[0];

    // 🧍‍♂️ Ensure Stripe customer exists (with fallback UK address)
    let stripeCustomerId = customer.stripe_customer_id;
    if (!stripeCustomerId) {
      const stripeCustomer = await stripe.customers.create({
        name: customer.name,
        email: customer.email,
        address: {
          line1: customer.address1 || "123 Test Street",
          city: customer.city || "London",
          country: "GB",
          postal_code: customer.postcode || "EC1A 1AA",
        },
        metadata: { pjh_customer_id: customer.id },
      });
      stripeCustomerId = stripeCustomer.id;

      await pool.query("UPDATE customers SET stripe_customer_id=$1 WHERE id=$2", [
        stripeCustomerId,
        customerId,
      ]);
    }

    // 💳 Create SetupIntent (no mandate_data yet — handled client-side)
    const setupIntent = await stripe.setupIntents.create({
      payment_method_types: ["bacs_debit"],
      customer: stripeCustomerId,
      usage: "off_session",
      metadata: { pjh_customer_id: customer.id },
    });

    // 📩 Generate hosted setup link (frontend confirmation flow)
    const setupUrl = `${FRONTEND_URL}/direct-debit-setup?client_secret=${setupIntent.client_secret}`;

    // 💌 Notify customer
    await sendEmail({
      to: customer.email,
      subject: "Set up your Direct Debit mandate — PJH Web Services",
      html: `
        <div style="font-family:Arial,sans-serif;color:#333;padding:20px;">
          <h2>Direct Debit Mandate Setup</h2>
          <p>Hi ${customer.name},</p>
          <p>You can securely complete your Direct Debit setup using the link below:</p>
          <p style="margin:20px 0;">
            <a href="${setupUrl}" style="background:#007bff;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;">Complete Setup</a>
          </p>
          <p>If you have any questions, contact <a href="mailto:info@pjhwebservices.co.uk">info@pjhwebservices.co.uk</a>.</p>
        </div>
      `,
    });

    res.json({
      success: true,
      client_secret: setupIntent.client_secret,
      hosted_link: setupUrl,
      message: "Direct Debit setup initiated successfully.",
    });
  } catch (err) {
    console.error("❌ Direct Debit setup failed:", err.message);
    if (err.raw) console.error("🔍 Stripe error details:", JSON.stringify(err.raw, null, 2));
    res.status(500).json({
      success: false,
      error: err.raw?.message || err.message || "Failed to initiate Direct Debit setup.",
    });
  }
});

/* ============================================================
   🔄 3️⃣ Stripe Webhook (Payments + Mandates + Receipts)
============================================================ */
router.post(
  "/webhook",
  express.raw({ type: "application/json" }),
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
      console.error("⚠️ Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    const data = event.data.object;

    try {
      switch (event.type) {
        /* ----------------------------------------------
           🧾 Mandate setup success/failure
        ---------------------------------------------- */
        case "mandate.updated":
        case "mandate.created":
          await pool.query(
            `
            UPDATE customers
            SET stripe_mandate_id=$1, direct_debit_active=$2
            WHERE stripe_customer_id=$3;
          `,
            [data.id, data.status === "active", data.customer]
          );
          console.log(`✅ Mandate updated: ${data.id} (${data.status})`);
          break;

        /* ----------------------------------------------
           💰 Payment Success (Card or Direct Debit)
        ---------------------------------------------- */
        case "payment_intent.succeeded": {
          const orderId = data.metadata?.order_id || null;
          const customerId = data.metadata?.customer_id || null;
          const amount = data.amount_received / 100;

          await pool.query(
            `INSERT INTO payments (stripe_event_id, order_id, customer_id, amount, type, method, reference, stripe_status, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'paid')
             ON CONFLICT (stripe_event_id) DO NOTHING;`,
            [
              event.id,
              orderId,
              customerId,
              amount,
              data.metadata?.payment_type || "card",
              data.payment_method_types?.[0] || "card",
              data.id,
              data.status,
            ]
          );

          if (orderId) {
            const { rows: orderRows } = await pool.query("SELECT * FROM orders WHERE id=$1", [
              orderId,
            ]);
            if (orderRows.length) {
              const order = orderRows[0];
              const newTotal = Number(order.total_paid || 0) + amount;
              await pool.query("UPDATE orders SET total_paid=$1 WHERE id=$2", [
                newTotal,
                orderId,
              ]);
            }
          }

          if (customerId) {
            const custRes = await pool.query("SELECT * FROM customers WHERE id=$1", [customerId]);
            if (custRes.rows.length) {
              await sendEmail({
                to: custRes.rows[0].email,
                subject: "Payment received — thank you!",
                html: paymentSuccessTemplate({
                  customerName: custRes.rows[0].name,
                  amount,
                }),
              });
            }
          }

          console.log(`💰 Payment recorded successfully (Order ${orderId})`);
          break;
        }

        /* ----------------------------------------------
           💸 Payment Failure
        ---------------------------------------------- */
        case "payment_intent.payment_failed": {
          const orderId = data.metadata?.order_id || null;
          const customerId = data.metadata?.customer_id || null;
          const amount = data.amount / 100;

          await pool.query(
            `INSERT INTO payments (stripe_event_id, order_id, customer_id, amount, type, method, reference, stripe_status, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'failed')
             ON CONFLICT (stripe_event_id) DO NOTHING;`,
            [
              event.id,
              orderId,
              customerId,
              amount,
              data.metadata?.payment_type || "card",
              data.payment_method_types?.[0] || "card",
              data.id,
              data.status,
            ]
          );

          if (customerId) {
            const cust = await pool.query("SELECT * FROM customers WHERE id=$1", [customerId]);
            if (cust.rows.length) {
              await sendEmail({
                to: cust.rows[0].email,
                subject: "Payment failed — action required",
                html: paymentFailureTemplate({
                  customerName: cust.rows[0].name,
                  amount,
                }),
              });
            }
          }

          console.warn(`⚠️ Payment failed: ${data.id}`);
          break;
        }

        /* ----------------------------------------------
           💷 Refunds & Cancellations
        ---------------------------------------------- */
        case "charge.refunded":
        case "payment_intent.canceled":
          await pool.query(
            `UPDATE payments SET status='refunded', stripe_status=$2 WHERE stripe_event_id=$1;`,
            [event.id, data.status]
          );
          console.log(`↩️ Payment refunded/cancelled: ${data.id}`);
          break;

        default:
          console.log(`ℹ️ Unhandled Stripe event type: ${event.type}`);
      }

      res.json({ received: true });
    } catch (err) {
      console.error("❌ Webhook processing error:", err);
      res.status(500).json({ success: false });
    }
  }
);

export default router;
