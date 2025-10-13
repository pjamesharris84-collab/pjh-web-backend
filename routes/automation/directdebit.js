/**
 * ============================================================
 * PJH Web Services — Direct Debit Automation (Monthly Billing)
 * ============================================================
 *  • Runs nightly (Render Cron or PM2)
 *  • Charges active mandates for their maintenance plans
 *  • Logs success/failure in `payments`
 * ============================================================
 */

import Stripe from "stripe";
import dotenv from "dotenv";
import pool from "../../db.js";

dotenv.config();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export async function runMonthlyDirectDebit() {
  console.log("🏦 Starting Direct Debit cycle...");

  const today = new Date();
  const day = today.getDate();
  if (day !== 1) {
    console.log("⏭️  Only runs on day 1 of month.");
    return;
  }

  // 1️⃣ Fetch all customers with active mandates + maintenance plan
  const { rows: customers } = await pool.query(`
    SELECT c.id AS customer_id, c.name, c.email,
           c.stripe_customer_id, c.stripe_mandate_id,
           m.price AS monthly_price, o.id AS order_id, o.title
    FROM customers c
    JOIN orders o ON o.customer_id = c.id
    JOIN maintenance_plans m ON o.maintenance_id = m.id
    WHERE c.direct_debit_active = true;
  `);

  for (const cust of customers) {
    try {
      const amount = Math.round(cust.monthly_price * 100);
      console.log(`💳 Charging ${cust.name} £${cust.monthly_price.toFixed(2)} via DD...`);

      const intent = await stripe.paymentIntents.create({
        amount,
        currency: "gbp",
        customer: cust.stripe_customer_id,
        payment_method_types: ["bacs_debit"],
        mandate: cust.stripe_mandate_id,
        confirm: true,
        description: `Monthly maintenance — ${cust.title}`,
        metadata: { order_id: cust.order_id, payment_type: "maintenance" },
      });

      await pool.query(
        `INSERT INTO payments (order_id, customer_id, amount, type, method, status, reference)
         VALUES ($1,$2,$3,'maintenance','bacs','processing',$4)`,
        [cust.order_id, cust.customer_id, cust.monthly_price, intent.id]
      );
    } catch (err) {
      console.error(`❌ Failed for ${cust.name}:`, err.message);
    }
  }

  console.log("✅ Monthly Direct Debit cycle complete.");
}
