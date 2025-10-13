// routes/billing.js
import express from "express";
import pool from "../db.js";
import Stripe from "stripe";
import dotenv from "dotenv";

dotenv.config();
const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const FRONTEND_URL = process.env.FRONTEND_URL || "https://www.pjhwebservices.co.uk";

// POST /api/billing/checkout
// body: { orderId, customerId, packageId, maintenanceId }
router.post("/checkout", async (req, res) => {
  try {
    const { orderId, customerId, packageId, maintenanceId } = req.body;
    if (!orderId || !customerId) {
      return res.status(400).json({ error: "orderId and customerId are required" });
    }

    // Load customer
    const { rows: cRows } = await pool.query("SELECT * FROM customers WHERE id=$1", [customerId]);
    const customer = cRows[0];
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    // Ensure Stripe customer
    let stripeCustomerId = customer.stripe_customer_id;
    if (!stripeCustomerId) {
      const sc = await stripe.customers.create({
        email: customer.email,
        name: customer.business || customer.name,
        metadata: { customer_id: String(customerId) },
      });
      stripeCustomerId = sc.id;
      await pool.query("UPDATE customers SET stripe_customer_id=$1 WHERE id=$2", [
        stripeCustomerId,
        customerId,
      ]);
    }

    // Build line items (package + maintenance are optional)
    const line_items = [];

    if (packageId) {
      const { rows: pRows } = await pool.query(
        "SELECT name, stripe_price_id FROM packages WHERE id=$1 AND visible=TRUE",
        [packageId]
      );
      const pkg = pRows[0];
      if (!pkg?.stripe_price_id) {
        return res.status(400).json({ error: "Package missing stripe_price_id" });
      }
      line_items.push({ price: pkg.stripe_price_id, quantity: 1 });
    }

    if (maintenanceId) {
      const { rows: mRows } = await pool.query(
        "SELECT name, stripe_price_id FROM maintenance_plans WHERE id=$1 AND visible=TRUE",
        [maintenanceId]
      );
      const plan = mRows[0];
      if (!plan?.stripe_price_id) {
        return res.status(400).json({ error: "Maintenance plan missing stripe_price_id" });
      }
      line_items.push({ price: plan.stripe_price_id, quantity: 1 });
    }

    if (!line_items.length) {
      return res.status(400).json({ error: "No subscription line items provided" });
    }

    // Create Checkout Session (subscription) with Direct Debit + Card
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: stripeCustomerId,
      payment_method_types: ["bacs_debit", "card"],
      line_items,
      success_url: `${FRONTEND_URL}/billing/success?order=${orderId}`,
      cancel_url: `${FRONTEND_URL}/billing/cancel?order=${orderId}`,
      // Pass identifiers so webhooks can map payments to your records
      subscription_data: {
        metadata: {
          pjh_customer_id: String(customerId),
          pjh_order_id: String(orderId),
          pjh_package_id: packageId ? String(packageId) : "",
          pjh_maintenance_id: maintenanceId ? String(maintenanceId) : "",
        },
      },
      metadata: {
        pjh_customer_id: String(customerId),
        pjh_order_id: String(orderId),
        pjh_package_id: packageId ? String(packageId) : "",
        pjh_maintenance_id: maintenanceId ? String(maintenanceId) : "",
      },
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("❌ /api/billing/checkout failed:", err.message);
    res.status(500).json({ error: "Failed to start checkout" });
  }
});

export default router;
