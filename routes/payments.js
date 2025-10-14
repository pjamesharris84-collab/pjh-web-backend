/**
 * ============================================================
 * PJH Web Services — Automated Direct Debit (Monthly Builds)
 * ============================================================
 * Handles:
 *  ✅ Monthly website build recharges (Stripe Bacs)
 *  ✅ Uses orders.monthly_amount (set automatically on creation)
 *  ✅ Full DB logging for payments (type = 'build')
 *  ✅ Auto-repairs missing Stripe IDs
 *  ✅ Skips safely if customer not eligible
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
   ⚡ GET /api/automation/directdebit/build-run?orderId=13
============================================================ */
router.get("/build-run", async (req, res) => {
  console.log("🏗️ Starting Monthly Build Direct Debit billing...");
  const { orderId } = req.query;

  try {
    // ------------------------------------------------------------
    // Load orders eligible for monthly build billing
    // ------------------------------------------------------------
    let query = `
      SELECT 
        o.id AS order_id,
        o.title,
        o.monthly_amount,
        o.customer_id,
        c.name AS customer_name,
        c.email AS customer_email,
        c.stripe_customer_id,
        c.stripe_payment_method_id,
        c.stripe_mandate_id,
        c.direct_debit_active
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      WHERE c.direct_debit_active = TRUE
        AND o.monthly_amount > 0
    `;

    const params = [];
    if (orderId) {
      query += " AND o.id = $1";
      params.push(orderId);
    }

    const { rows } = await pool.query(query, params);

    if (!rows.length) {
      console.log("⚠️ No eligible monthly build customers found.");
      return res.json({ success: true, message: "No active build DD customers found." });
    }

    // ------------------------------------------------------------
    // Process each eligible order
    // ------------------------------------------------------------
    let totalChecked = 0,
      charged = 0,
      skipped = 0,
      failed = 0;

    for (const row of rows) {
      totalChecked++;
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

      // Safely cast monthly_amount to number
      const monthlyAmount = Number(monthly_amount) || 0;
      if (isNaN(monthlyAmount) || monthlyAmount <= 0) {
        console.warn(`⚠️ Skipped ${customer_name}: Invalid monthly amount (${monthly_amount})`);
        skipped++;
        continue;
      }

      if (!stripe_customer_id) {
        console.warn(`⚠️ Skipped ${customer_name}: Missing Stripe customer ID.`);
        skipped++;
        continue;
      }

      // ------------------------------------------------------------
      // Auto-repair Stripe IDs if missing
      // ------------------------------------------------------------
      let paymentMethodId = stripe_payment_method_id;
      let mandateId = stripe_mandate_id;

      if (!paymentMethodId) {
        const methods = await stripe.paymentMethods.list({
          customer: stripe_customer_id,
          type: "bacs_debit",
        });
        if (methods.data?.length) {
          paymentMethodId = methods.data[0].id;
          await pool.query(
            `UPDATE customers SET stripe_payment_method_id=$1 WHERE stripe_customer_id=$2`,
            [paymentMethodId, stripe_customer_id]
          );
          console.log(`🔄 Auto-updated payment method for ${customer_name}: ${paymentMethodId}`);
        }
      }

      if (!mandateId && paymentMethodId) {
        const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
        if (pm?.bacs_debit?.mandate) {
          mandateId = pm.bacs_debit.mandate;
          await pool.query(
            `UPDATE customers SET stripe_mandate_id=$1 WHERE stripe_customer_id=$2`,
            [mandateId, stripe_customer_id]
          );
          console.log(`🔄 Auto-updated mandate for ${customer_name}: ${mandateId}`);
        }
      }

      if (!paymentMethodId || !mandateId) {
        console.warn(`⚠️ Skipped ${customer_name}: Missing Stripe linkage`);
        skipped++;
        continue;
      }

      // ------------------------------------------------------------
      // Create PaymentIntent via Stripe Bacs
      // ------------------------------------------------------------
      try {
        console.log(
          `💳 Charging ${customer_name} £${monthlyAmount.toFixed(
            2
          )} for Monthly Build (Order #${order_id})...`
        );

        const intent = await stripe.paymentIntents.create({
          amount: Math.round(monthlyAmount * 100),
          currency: "gbp",
          customer: stripe_customer_id,
          payment_method: paymentMethodId,
          confirm: true,
          mandate: mandateId,
          description: `Monthly Website Build — ${title}`,
          automatic_payment_methods: { enabled: true, allow_redirects: "never" },
          metadata: {
            order_id,
            customer_id,
            payment_type: "build",
            source: "automation",
          },
        });

        // ------------------------------------------------------------
        // Log payment in database
        // ------------------------------------------------------------
        const status =
          intent.status === "succeeded"
            ? "paid"
            : intent.status === "processing"
            ? "processing"
            : "pending";

        await pool.query(
          `
          INSERT INTO payments 
            (order_id, customer_id, amount, type, method, status, reference, created_at)
          VALUES ($1,$2,$3,'build','bacs_debit',$4,$5,NOW())
          ON CONFLICT (reference) DO UPDATE SET status=$4;
          `,
          [order_id, customer_id, monthlyAmount, status, intent.id]
        );

        charged++;
        console.log(
          `✅ Direct Debit (Build) logged: ${customer_name} — £${monthlyAmount.toFixed(
            2
          )} (${status})`
        );
      } catch (err) {
        failed++;
        console.error(`❌ Failed to charge ${customer_name}: ${err.message}`);
      }
    }

    // ------------------------------------------------------------
    // Done
    // ------------------------------------------------------------
    console.table({ totalChecked, charged, skipped, failed });
    console.log("🏁 Monthly build billing cycle complete.");
    res.json({ success: true, message: "Monthly build run complete" });
  } catch (err) {
    console.error("❌ Monthly build automation failed:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
