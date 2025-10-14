/**
 * ============================================================
 * PJH Web Services — Automated Direct Debit Billing (2025)
 * ============================================================
 * Handles:
 *  ✅ Monthly maintenance and subscription recharges
 *  ✅ Stripe Direct Debit automation (Bacs)
 *  ✅ Logs payments in DB (type = 'maintenance')
 *  ✅ Full visibility in AdminOrderRecord
 *  ✅ Defensive checks for missing IDs
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
============================================================ */
router.get("/run", async (req, res) => {
  console.log("🏦 Starting Direct Debit billing...");
  const { orderId } = req.query;

  try {
    // -------------------------------------------------------------------
    // Load customers to bill (filtered by direct_debit_active)
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
      console.log("⚠️ No active DD customers found.");
      return res.json({ success: true, message: "No active DD customers found." });
    }

    // -------------------------------------------------------------------
    // Iterate through eligible customers
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

      if (!stripe_customer_id || !stripe_payment_method_id || !stripe_mandate_id) {
        console.warn(`⚠️ Skipped ${customer_name}: Missing Stripe linkage.
          Customer ID: ${stripe_customer_id || "❌"}
          Payment Method: ${stripe_payment_method_id || "❌"}
          Mandate: ${stripe_mandate_id || "❌"}
        `);
        continue;
      }

      // -------------------------------------------------------------------
      // Create Direct Debit charge via Stripe
      // -------------------------------------------------------------------
      console.log(`💳 Charging ${customer_name} £${monthlyAmount.toFixed(2)} via Direct Debit...`);
      try {
        const intent = await stripe.paymentIntents.create({
          amount: Math.round(monthlyAmount * 100),
          currency: "gbp",
          customer: stripe_customer_id,
          payment_method: stripe_payment_method_id,
          confirm: true,
          description: `Monthly Maintenance — ${title}`,
          mandate: stripe_mandate_id,
          metadata: {
            order_id,
            customer_id,
            type: "maintenance",
            source: "automation",
          },
        });

        // -------------------------------------------------------------------
        // Log the payment in database
        // -------------------------------------------------------------------
        if (intent.status === "succeeded" || intent.status === "processing") {
          await pool.query(
            `INSERT INTO payments 
             (order_id, customer_id, amount, type, method, status, reference, created_at)
             VALUES ($1,$2,$3,'maintenance','bacs',$4,$5,NOW())
             ON CONFLICT (reference) DO NOTHING;`,
            [
              order_id,
              customer_id,
              monthlyAmount,
              intent.status === "succeeded" ? "paid" : "processing",
              intent.id,
            ]
          );
          console.log(`✅ Direct Debit success: ${customer_name} — £${monthlyAmount} (${intent.status})`);
        } else {
          console.warn(`⚠️ Stripe intent created but not succeeded: ${intent.status}`);
        }
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
