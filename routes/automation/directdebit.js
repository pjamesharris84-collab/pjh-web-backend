/**
 * ============================================================
 * PJH Web Services — Automated Direct Debit Billing (2025)
 * ============================================================
 *  • Charges all customers with active mandates
 *  • Pulls the maintenance plan price from linked order
 *  • Logs success/failure in `payments`
 * ============================================================
 */

import Stripe from "stripe";
import dotenv from "dotenv";
import pool from "../../db.js";

dotenv.config();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export async function runMonthlyDirectDebit(orderIdOverride = null) {
  console.log("🏦 Starting Direct Debit billing...");

  // 1️⃣ Fetch all customers with active mandates
  const { rows: customers } = await pool.query(
    `
    SELECT 
      c.id AS customer_id, 
      c.name, 
      c.email,
      c.stripe_customer_id,
      c.stripe_mandate_id,
      o.id AS order_id,
      o.title,
      o.maintenance_id,
      m.price AS monthly_price
    FROM customers c
    JOIN orders o ON o.customer_id = c.id
    JOIN maintenance_plans m ON o.maintenance_id = m.id
    WHERE c.direct_debit_active = true
      ${orderIdOverride ? "AND o.id = $1" : ""}
    `,
    orderIdOverride ? [orderIdOverride] : []
  );

  if (customers.length === 0) {
    console.log("ℹ️ No customers with active Direct Debit mandates.");
    return;
  }

  for (const cust of customers) {
    try {
      const amount = Math.round(Number(cust.monthly_price) * 100);
      console.log(`💳 Charging ${cust.name} £${cust.monthly_price} via Direct Debit...`);

      const intent = await stripe.paymentIntents.create({
        amount,
        currency: "gbp",
        customer: cust.stripe_customer_id,
        payment_method_types: ["bacs_debit"],
        mandate: cust.stripe_mandate_id,
        confirm: true,
        description: `Monthly Maintenance — ${cust.title}`,
        metadata: {
          order_id: cust.order_id,
          payment_type: "maintenance",
        },
      });

      await pool.query(
        `INSERT INTO payments (order_id, customer_id, amount, type, method, status, reference)
         VALUES ($1,$2,$3,'maintenance','bacs','processing',$4)`,
        [cust.order_id, cust.customer_id, cust.monthly_price, intent.id]
      );

      console.log(`✅ PaymentIntent created: ${intent.id} — £${cust.monthly_price}`);
    } catch (err) {
      console.error(`❌ Failed to charge ${cust.name}:`, err.message);
    }
  }

  console.log("🏁 Direct Debit billing cycle complete.");
}
