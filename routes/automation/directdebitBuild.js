/**
 * ============================================================
 * PJH Web — Automated Direct Debit (Monthly Builds)
 * ============================================================
 * Triggers monthly website build charges via Stripe Bacs Debit.
 * Logs a "monthly_build" payment in DB.
 * ============================================================
 */
import express from "express";
import pool from "../../db.js";
import Stripe from "stripe";
import dotenv from "dotenv";

dotenv.config();
const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/* ============================================================
   ⚡ GET /api/automation/directdebit/build-run?orderId=##
============================================================ */
router.get("/build-run", async (req, res) => {
  console.log("🏗️ Starting Monthly Build Direct Debit billing...");
  const { orderId } = req.query;

  let totals = { totalChecked: 0, charged: 0, skipped: 0, failed: 0 };

  try {
    // 1) Find orders that are monthly & have an active mandate
    let q = `
      SELECT 
        o.id AS order_id,
        o.title,
        o.monthly_amount,
        o.customer_id,
        o.pricing_mode,
        c.name AS customer_name,
        c.email AS customer_email,
        c.stripe_customer_id,
        c.stripe_payment_method_id,
        c.stripe_mandate_id,
        c.direct_debit_active
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      WHERE c.direct_debit_active = TRUE
        AND o.pricing_mode = 'monthly'
    `;
    const params = [];
    if (orderId) {
      q += " AND o.id = $1";
      params.push(orderId);
    }

    const { rows } = await pool.query(q, params);
    if (!rows.length) {
      console.log("⚠️ No active monthly build customers found.");
      return res.json({ success: true, message: "No active monthly builds found." });
    }

    // 2) Charge each order
    for (const row of rows) {
      totals.totalChecked++;

      const {
        order_id,
        title,
        monthly_amount,
        customer_id,
        customer_name,
        stripe_customer_id,
        stripe_payment_method_id,
        stripe_mandate_id,
      } = row;

      const amount = Number(monthly_amount || 0);
      if (!amount || amount <= 0) {
        totals.skipped++;
        console.log(`⬇️ Skipped ${customer_name} — no monthly amount set.`);
        continue;
      }

      if (!stripe_customer_id || !stripe_payment_method_id || !stripe_mandate_id) {
        totals.skipped++;
        console.warn(`⚠️ Skipped ${customer_name}: Missing Stripe linkage.`);
        continue;
      }

      try {
        console.log(`💳 Charging ${customer_name} £${amount.toFixed(2)} (monthly build)…`);

        // Use automatic_payment_methods so we don't need a return_url
        const intent = await stripe.paymentIntents.create({
          amount: Math.round(amount * 100),
          currency: "gbp",
          customer: stripe_customer_id,
          payment_method: stripe_payment_method_id,
          mandate: stripe_mandate_id,
          confirm: true,
          description: `Monthly Website Build — ${title}`,
          metadata: {
            order_id,
            customer_id,
            type: "monthly_build",
            source: "automation",
          },
          automatic_payment_methods: {
            enabled: true,
            allow_redirects: "never",
          },
        });

        // Record as processing (will flip to paid/failed via webhook)
        await pool.query(
          `
          INSERT INTO payments 
            (order_id, customer_id, amount, type, method, status, reference, created_at)
          VALUES ($1,$2,$3,'monthly_build','bacs_debit','processing',$4,NOW())
          ON CONFLICT (reference) DO NOTHING;
          `,
          [order_id, customer_id, amount, intent.id]
        );

        totals.charged++;
        console.log(`✅ DD queued: ${customer_name} — £${amount} (${intent.status})`);
      } catch (err) {
        totals.failed++;
        console.error(`❌ Failed to charge ${customer_name}: ${err.message}`);
      }
    }

    console.table(totals);
    res.json({ success: true, message: "Monthly build batch run complete.", totals });
  } catch (err) {
    console.error("❌ Monthly build automation failed:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
