/**
 * ============================================================
 * PJH Web Services — Automated Direct Debit Billing (2025)
 * ============================================================
 * Handles:
 *  ✅ Monthly maintenance and subscription recharges
 *  ✅ Stripe Direct Debit automation (Bacs)
 *  ✅ Logs payments in DB (type = 'maintenance')
 *  ✅ Auto-updates in AdminOrderRecord via webhook polling
 *  ✅ Defensive checks & auto-repair for missing Stripe IDs
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
   ⚡ GET /api/automation/directdebit/run?orderId=10
   Triggers monthly Bacs Direct Debit billing
============================================================ */
router.get("/run", async (req, res) => {
  console.log("🏦 Starting Direct Debit billing...");
  const { orderId } = req.query;

  try {
    // -------------------------------------------------------------------
    // Load customers eligible for Direct Debit billing
    // -------------------------------------------------------------------
    let query = `
      SELECT 
        o.id AS order_id, 
        o.title, 
        o.maintenance_id,
        o.maintenance_monthly,
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
    `;

    const params = [];
    if (orderId) {
      query += " AND o.id = $1";
      params.push(orderId);
    }

    const { rows } = await pool.query(query, params);
    if (!rows.length) {
      console.log("⚠️ No active Direct Debit customers found.");
      return res.json({ success: true, message: "No active DD customers found." });
    }

    // -------------------------------------------------------------------
    // Iterate through each customer and charge via Stripe
    // -------------------------------------------------------------------
    for (const row of rows) {
      const {
        order_id,
        title,
        maintenance_monthly,
        customer_id,
        customer_name,
        stripe_customer_id,
        stripe_payment_method_id,
        stripe_mandate_id,
      } = row;

      const monthlyAmount = Number(maintenance_monthly || 0);
      if (!monthlyAmount || monthlyAmount <= 0) {
        console.log(`⬇️ Skipped ${customer_name} — no monthly maintenance set.`);
        continue;
      }

      // -------------------------------------------------------------------
      // Validate Stripe linkage — fetch missing IDs if possible
      // -------------------------------------------------------------------
      let paymentMethodId = stripe_payment_method_id;
      let mandateId = stripe_mandate_id;

      if (!stripe_customer_id) {
        console.warn(`⚠️ Skipped ${customer_name}: Missing Stripe customer ID.`);
        continue;
      }

      // Attempt to auto-repair missing payment or mandate
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

      if (!mandateId) {
        // try fetching from Stripe customer mandates if available
        const pm = paymentMethodId ? await stripe.paymentMethods.retrieve(paymentMethodId) : null;
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
        console.warn(`⚠️ Skipped ${customer_name}: Missing linkage
          Customer: ${stripe_customer_id}
          PaymentMethod: ${paymentMethodId || "❌"}
          Mandate: ${mandateId || "❌"}
        `);
        continue;
      }

      // -------------------------------------------------------------------
      // Create Direct Debit payment intent
      // -------------------------------------------------------------------
      console.log(`💳 Charging ${customer_name} £${monthlyAmount.toFixed(2)} via Direct Debit...`);
      try {
        const intent = await stripe.paymentIntents.create({
          amount: Math.round(monthlyAmount * 100),
          currency: "gbp",
          customer: stripe_customer_id,
          payment_method: paymentMethodId,
          confirm: true,
          mandate: mandateId,
          description: `Monthly Maintenance — ${title}`,
          metadata: {
            order_id,
            customer_id,
            type: "maintenance",
            source: "automation",
          },
        });

        // -------------------------------------------------------------------
        // Log the payment in database immediately as "processing" or "paid"
        // (webhook will later update to 'paid' or 'failed')
        // -------------------------------------------------------------------
        const status = intent.status === "succeeded" ? "paid" : "processing";

        await pool.query(
          `INSERT INTO payments 
             (order_id, customer_id, amount, type, method, status, reference, created_at)
           VALUES ($1,$2,$3,'maintenance','bacs',$4,$5,NOW())
           ON CONFLICT (reference) DO UPDATE SET status=$4;`,
          [order_id, customer_id, monthlyAmount, status, intent.id]
        );

        console.log(
          `✅ Direct Debit queued: ${customer_name} — £${monthlyAmount} (${intent.status})`
        );
      } catch (err) {
        console.error(`❌ Failed to charge ${customer_name}: ${err.message}`);
      }
    }

    console.log("🏁 Direct Debit billing cycle complete.");
    res.json({ success: true, message: "Batch run complete" });
  } catch (err) {
    console.error("❌ Direct Debit automation failed:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
