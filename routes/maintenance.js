/**
 * ============================================================
 * PJH Web Services — Maintenance Plans API (2025-11, VAT-Aligned)
 * ============================================================
 * Handles WebCare plan listing, signup, and Stripe subscription creation.
 *
 * Current Plans (ex-VAT):
 *  • Essential Care   — £45/mo  · Backups, updates & security
 *  • WebCare Plus     — £85/mo  · Performance, reports & priority support
 *  • WebCare Premium  — £145/mo · Full WebCare, SEO, audits & emergency fixes
 *
 * Stripe prices are billed inclusive of VAT (20%) for transparency.
 * ============================================================
 */

import express from "express";
import pool from "../db.js";
import dotenv from "dotenv";
import Stripe from "stripe";
// import { sendEmail } from "../utils/email.js";
// import { maintenanceSignupTemplate } from "../utils/emailTemplates.js";

dotenv.config();

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const FRONTEND_URL =
  process.env.FRONTEND_URL || "https://www.pjhwebservices.co.uk";

/* ------------------------------------------------------------
   GET /api/maintenance/plans — Public plan list
------------------------------------------------------------ */
router.get("/plans", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, name, price, description, features
      FROM maintenance_plans
      WHERE visible = TRUE
      ORDER BY price ASC;
    `);

    if (!rows.length) {
      // Fallback plans if database table empty
      return res.json([
        {
          name: "Essential Care",
          price: 45,
          description:
            "Perfect for small brochure or Starter sites — monthly updates, daily backups, and basic uptime monitoring.",
          features: [
            "Monthly plugin & core updates",
            "Daily backups (7-day retention)",
            "Basic uptime monitoring",
            "Email support within 2 business days",
          ],
        },
        {
          name: "WebCare Plus",
          price: 85,
          description:
            "Ideal for growing sites that need regular updates, SEO health checks, and faster support turnaround.",
          features: [
            "Bi-weekly updates & security scans",
            "Daily backups (14-day retention)",
            "Monthly performance report",
            "Priority same-day email support",
          ],
        },
        {
          name: "WebCare Premium",
          price: 145,
          description:
            "For e-commerce or CRM-driven sites where uptime, SEO audits, and emergency fixes are essential.",
          features: [
            "Weekly updates & deep security scans",
            "Real-time uptime monitoring",
            "Monthly performance & SEO audit",
            "Priority phone & email support",
            "Emergency fixes included",
          ],
        },
      ]);
    }

    res.json(rows);
  } catch (err) {
    console.error("❌ [DB] Error fetching maintenance plans:", err.message);
    res.status(500).json({ error: "Failed to load maintenance plans" });
  }
});

/* ------------------------------------------------------------
   POST /api/maintenance/signup — Create Stripe subscription
------------------------------------------------------------ */
router.post("/signup", async (req, res) => {
  try {
    const { name, email, planId } = req.body;

    if (!name || !email || !planId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Fetch plan
    const { rows } = await pool.query(
      "SELECT * FROM maintenance_plans WHERE id = $1 AND visible = TRUE",
      [planId]
    );
    const plan = rows[0];
    if (!plan) return res.status(404).json({ error: "Plan not found" });

    // Calculate VAT-inclusive amount
    const grossAmount = Math.round(plan.price * 1.2 * 100); // pence

    // Create Stripe Checkout Session (subscription)
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "gbp",
            unit_amount: grossAmount,
            tax_behavior: "inclusive",
            recurring: { interval: "month" },
            product_data: {
              name: `${plan.name} — PJH WebCare`,
              description: plan.description,
            },
          },
          quantity: 1,
        },
      ],
      customer_email: email,
      success_url: `${FRONTEND_URL}/maintenance/thank-you`,
      cancel_url: `${FRONTEND_URL}/maintenance`,
      metadata: {
        plan_name: plan.name,
        plan_price_ex_vat: plan.price.toFixed(2),
        vat_rate: "20%",
        customer_name: name,
        customer_email: email,
      },
      automatic_tax: { enabled: false },
    });

    // Log signup in DB
    await pool.query(
      `
        INSERT INTO maintenance_signups
          (customer_name, email, plan_name, plan_price, status, created_at)
        VALUES ($1, $2, $3, $4, 'pending', NOW());
      `,
      [name, email, plan.name, plan.price]
    );

    // Optional: send confirmation email (disabled in dev)
    /*
    await sendEmail({
      to: email,
      subject: `Welcome to ${plan.name} — PJH WebCare`,
      html: maintenanceSignupTemplate(name, plan.name, plan.price),
    });
    */

    res.json({ success: true, url: session.url });
  } catch (err) {
    console.error("❌ [API] Error creating maintenance signup:", err.message);
    res.status(500).json({ error: "Failed to start signup process" });
  }
});

export default router;
