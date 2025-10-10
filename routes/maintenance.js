/**
 * ============================================================
 * PJH Web Services — Maintenance Plans API
 * ============================================================
 * Handles plan listing, customer signup, and subscription creation.
 * ============================================================
 */

import express from "express";
import pool from "../db.js";
import dotenv from "dotenv";
import Stripe from "stripe";
//import { sendEmail } from "../utils/email.js";
//import { maintenanceSignupTemplate } from "../utils/emailTemplates.js";

dotenv.config();

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const FRONTEND_URL =
  process.env.FRONTEND_URL ||
  "https://www.pjhwebservices.co.uk";

/* -----------------------------
   GET /api/maintenance/plans
-------------------------------- */
router.get("/plans", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, name, price, description, features
      FROM maintenance_plans
      ORDER BY price ASC;
    `);
    res.json(rows);
  } catch (err) {
    console.error("❌ Error fetching maintenance plans:", err);
    res.status(500).json({ error: "Failed to load maintenance plans" });
  }
});

/* -----------------------------
   POST /api/maintenance/signup
-------------------------------- */
router.post("/signup", async (req, res) => {
  try {
    const { name, email, planId } = req.body;

    if (!name || !email || !planId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Get plan details
    const { rows } = await pool.query(
      "SELECT * FROM maintenance_plans WHERE id = $1",
      [planId]
    );
    const plan = rows[0];
    if (!plan) return res.status(404).json({ error: "Plan not found" });

    // Create Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      line_items: [
        {
          price_data: {
            currency: "gbp",
            product_data: { name: `${plan.name} Maintenance Plan` },
            unit_amount: plan.price * 100, // convert £ to pence
            recurring: { interval: "month" },
          },
          quantity: 1,
        },
      ],
      customer_email: email,
      success_url: `${FRONTEND_URL}/maintenance/thank-you`,
      cancel_url: `${FRONTEND_URL}/maintenance`,
    });

    // Log in database
    await pool.query(
      `INSERT INTO maintenance_signups (customer_name, email, plan_name, plan_price, status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [name, email, plan.name, plan.price]
    );

    // Send confirmation email
    await sendEmail({
      to: email,
      subject: `Welcome to ${plan.name} — PJH WebCare`,
      html: maintenanceSignupTemplate(name, plan.name, plan.price),
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Error creating maintenance signup:", err);
    res.status(500).json({ error: "Failed to start signup" });
  }
});

export default router;
