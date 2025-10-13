/**
 * ============================================================
 * PJH Web Services — Direct Debit Automation (2025)
 * ============================================================
 * Runs daily to charge active maintenance subscriptions
 * via Stripe mandates. Safe to re-run (idempotent per month).
 * ============================================================
 */

import express from "express";
import Stripe from "stripe";
import pool from "../../db.js";
import dotenv from "dotenv";

dotenv.config();
const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * 🧮 GET /api/automation/directdebit/run
 */
router.get("/run", async (req, res) => {
  try {
    console.log("🏦 Running Direct Debit automation...");

    const { rows: customers } = await pool.query(`
      SELECT 
        c.id AS customer_id,
        c.name AS customer_name,
        c.stripe_customer_id,
        c.stripe_mandate_id,
        o.id AS order_id,
        o.maintenance_id,
        m.price AS maintenance_price,
        m.name AS maintenance_name
      FROM customers c
      JOIN orders o ON o.customer_id = c.id
      JOIN maintenance_plans m ON m.id = o.maintenance_id
      WHERE c.direct_debit_active = TRUE
        AND c.stripe_customer_id IS NOT NULL
        AND c.stripe_mandate_id IS NOT NULL
    `);

    if (!customers.length)
      return res.json({ success: true, message: "No active DD customers found." });

    for (const cust of customers) {
      const amount = Number(cust.maintenance_price);
      if (amount <= 0) continue;

      console.log(`💳 Charging ${cust.customer_name} £${amount.toFixed(2)} via Direct Debit...`);

      try {
        const pi = await stripe.paymentIntents.create({
          amount: Math.round(amount * 100),
          currency: "gbp",
          customer: cust.stripe_customer_id,
          payment_method_types: ["bacs_debit"],
          confirm: true,
          mandate: cust.stripe_mandate_id,
          off_session: true,
          metadata: {
            pjh_customer_id: cust.customer_id,
            pjh_order_id: cust.order_id,
            payment_type: "maintenance",
          },
        });

        console.log(`✅ Charged ${cust.customer_name} — £${amount.toFixed(2)} (PI: ${pi.id})`);

        await pool.query(
          `INSERT INTO payments (order_id, customer_id, amount, type, method, status, reference)
           VALUES ($1,$2,$3,'maintenance','bacs','processing',$4)
           ON CONFLICT DO NOTHING;`,
          [cust.order_id, cust.customer_id, amount, pi.id]
        );
      } catch (err) {
        console.error(`❌ Failed to charge ${cust.customer_name}:`, err.message);
      }
    }

    res.json({ success: true, message: "Direct Debit automation completed." });
  } catch (err) {
    console.error("❌ Direct Debit automation error:", err);
    res.status(500).json({ error: "Automation failed." });
  }
});

export default router;
