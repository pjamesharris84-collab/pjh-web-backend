/**
 * ============================================================
 * PJH Web Services — Automated Direct Debit Billing (2025)
 * ============================================================
 *  • Charges all customers with active mandates
 *  • Pulls the maintenance plan price from linked QUOTE (preferred) or ORDER
 *  • Logs success/failure in `payments`
 *  • Safe if orders.maintenance_monthly is NULL or column missing in SELECT
 * ============================================================
 */

import Stripe from "stripe";
import dotenv from "dotenv";
import pool from "../../db.js";

dotenv.config();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export async function runMonthlyDirectDebit(orderIdOverride = null) {
  console.log("🏦 Starting Direct Debit billing...");

  // 1️⃣ Fetch all targets: Join orders → quotes → maintenance_plans (source of truth)
  // We prefer pulling maintenance price from the QUOTE's maintenance_id.
  // Fallback to orders.maintenance_monthly if present (NULL-safe COALESCE).
  const params = [];
  let filter = "";
  if (orderIdOverride) {
    params.push(orderIdOverride);
    filter = "AND o.id = $1";
  }

  const { rows: customers } = await pool.query(
    `
    SELECT 
      c.id       AS customer_id, 
      c.name     AS customer_name, 
      c.email,
      c.stripe_customer_id,
      c.stripe_mandate_id,
      c.direct_debit_active,
      o.id       AS order_id,
      o.title,
      COALESCE(m.price, o.maintenance_monthly, 0)::numeric AS monthly_price
    FROM customers c
    JOIN orders o            ON o.customer_id = c.id
    LEFT JOIN quotes q       ON q.id = o.quote_id
    LEFT JOIN maintenance_plans m ON m.id = q.maintenance_id
    WHERE c.direct_debit_active = true
    ${filter}
    `,
    params
  );

  if (!customers.length) {
    console.log("ℹ️ No customers with active Direct Debit mandates.");
    return;
  }

  for (const cust of customers) {
    try {
      const monthly = Number(cust.monthly_price || 0);
      if (monthly <= 0) {
        console.log(`⬇️ Skipped ${cust.customer_name} — no monthly maintenance set.`);
        continue;
      }

      const amount = Math.round(monthly * 100);
      console.log(`💳 Charging ${cust.customer_name} £${monthly.toFixed(2)} via Direct Debit...`);

      // Create PaymentIntent with Bacs + mandate (off-session)
      const intent = await stripe.paymentIntents.create({
        amount,
        currency: "gbp",
        customer: cust.stripe_customer_id,
        payment_method_types: ["bacs_debit"],
        mandate: cust.stripe_mandate_id, // uses existing mandate
        confirm: true,
        off_session: true,
        description: `Monthly Maintenance — ${cust.title}`,
        metadata: {
          order_id: String(cust.order_id),
          payment_type: "maintenance",
        },
      });

      await pool.query(
        `
        INSERT INTO payments (order_id, customer_id, amount, type, method, status, reference)
        VALUES ($1,$2,$3,'maintenance','bacs','processing',$4)
        `,
        [cust.order_id, cust.customer_id, monthly, intent.id]
      );

      console.log(`✅ PaymentIntent created: ${intent.id} — £${monthly.toFixed(2)}`);
    } catch (err) {
      console.error(`❌ Failed to charge ${cust.customer_name}:`, err.message);
      // Optionally record a failed payment row here
      try {
        await pool.query(
          `
          INSERT INTO payments (order_id, customer_id, amount, type, method, status, reference)
          VALUES ($1,$2,$3,'maintenance','bacs','failed',NULL)
          `,
          [cust.order_id, cust.customer_id, Number(cust.monthly_price || 0)]
        );
      } catch (_) {}
    }
  }

  console.log("🏁 Direct Debit billing cycle complete.");
}
