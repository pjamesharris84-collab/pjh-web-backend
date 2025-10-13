/**
 * ============================================================
 * PJH Web Services — Maintenance Plans API (2025-10 Refined)
 * ============================================================
 * Handles WebCare plan listing, customer signup, and
 * Stripe subscription creation for PJH Web Services clients.
 *
 * Plans:
 *  • Essential Care   — £45/mo · Basic security & updates
 *  • Performance Care — £95/mo · Speed, SEO & monthly health
 *  • Total WebCare    — £195/mo · Full care, edits & reporting
 *
 * Designed for:
 *  • Transparency (no hidden fees)
 *  • Simplicity (plain-English features)
 *  • Local reliability (Suffolk-based support)
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
const FRONTEND_URL = process.env.FRONTEND_URL || "https://www.pjhwebservices.co.uk";

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

    // If table empty, fallback to hardcoded defaults
    if (!rows.length) {
      return res.json([
        {
          name: "Essential Care",
          price: 45,
          description:
            "Basic protection for small business sites — includes backups, updates, and security checks.",
          features: [
            "Weekly backups & plugin updates",
            "Security & uptime monitoring",
            "Malware protection & SSL renewal",
            "Email-based support (48h response)",
          ],
        },
        {
          name: "Performance Care",
          price: 95,
          description:
            "Proactive site care with speed monitoring, SEO checks, and monthly reports.",
          features: [
            "All Essential features included",
            "Monthly SEO & performance audit",
            "Speed & mobile optimisation checks",
            "1 hour of content edits per month",
            "Priority support within 48h",
          ],
        },
        {
          name: "Total WebCare",
          price: 195,
          description:
            "Complete WebCare — full edits, analytics, reports, and emergency fixes included.",
          features: [
            "All Performance features included",
            "3 hours of monthly content updates",
            "Full analytics dashboard access",
            "Quarterly strategy call",
            "Emergency fixes included (no charge)",
            "Priority support within 24h",
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
   POST /api/maintenance/signup — Create subscription
------------------------------------------------------------ */
router.post("/signup", async (req, res) => {
  try {
    const { name, email, planId } = req.body;

    if (!name || !email || !planId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Fetch plan info
    const { rows } = await pool.query(
      "SELECT * FROM maintenance_plans WHERE id = $1 AND visible = TRUE",
      [planId]
    );
    const plan = rows[0];
    if (!plan) return res.status(404).json({ error: "Plan not found" });

    // Stripe: create subscription session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      line_items: [
        {
          price_data: {
            currency: "gbp",
            product_data: {
              name: `${plan.name} — PJH WebCare`,
              description: plan.description,
            },
            unit_amount: Math.round(plan.price * 100),
            recurring: { interval: "month" },
          },
          quantity: 1,
        },
      ],
      customer_email: email,
      success_url: `${FRONTEND_URL}/maintenance/thank-you`,
      cancel_url: `${FRONTEND_URL}/maintenance`,
      metadata: { plan: plan.name, customer: name },
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

    // Optional: Send confirmation email (commented for dev safety)
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
    res.status(500).json({ error: "Failed to start signup" });
  }
});

export default router;
