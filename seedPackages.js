/**
 * ============================================================
 * PJH Web Services — Package Seeder Script (2025 Enhanced)
 * ============================================================
 * Populates the `packages` table with full, descriptive website
 * packages that reflect PJH Web Services’ honest, local approach.
 *
 * Includes:
 *  • Starter  — the essentials done properly
 *  • Business — scalable systems for growing companies
 *  • Premium  — full bespoke CRM, automation & ongoing strategy
 * ------------------------------------------------------------
 * Each package includes realistic marketing copy and features
 * that communicate value, clarity, and no-nonsense delivery.
 * ============================================================
 */

import dotenv from "dotenv";
import pool from "./db.js";

dotenv.config();

async function seedPackages() {
  try {
    console.log("🌱 Checking existing packages…");

    const { rows: existing } = await pool.query(`SELECT COUNT(*) FROM packages`);
    const count = Number(existing[0].count || 0);

    if (count > 0) {
      console.log(`✅ ${count} package(s) already exist — skipping seed.`);
      process.exit(0);
    }

    console.log("📦 Seeding enhanced default packages…");

    const packages = [
      {
        name: "Starter",
        tagline: "Get online with confidence — no fluff, just results",
        price_oneoff: 900,
        price_monthly: 60,
        term_months: 24,
        features: [
          "5-page custom-built website designed around your business",
          "Fully mobile-responsive and lightning-fast performance",
          "Local SEO setup and Google optimisation to help you rank",
          "Integrated contact form, maps, and social links",
          "Domain registration and secure managed hosting included",
          "Ongoing updates and content edits available via WebCare",
        ],
        description: `
          The Starter package is perfect for tradesmen, small shops, and local
          sole traders who simply want a professional, modern website that works.
          No buzzwords, no gimmicks — just clean design, real SEO, and a trusted
          online presence that helps customers find you.
          
          We cut through the marketing noise that tells small businesses they
          “need a funnel”, “need daily ads”, or “need to go viral”. You don’t.
          You need a reliable, Google-friendly website that actually converts
          local enquiries into paying customers — and we deliver exactly that.
        `,
        visible: true,
      },
      {
        name: "Business",
        tagline: "Designed for growing companies ready to scale up",
        price_oneoff: 2600,
        price_monthly: 140,
        term_months: 24,
        features: [
          "Everything from the Starter plan, plus:",
          "Custom CRM core built for your workflow (quotes, bookings, invoices)",
          "Online booking and scheduling system with automated emails",
          "Integrated invoicing and payment tracking dashboard",
          "Advanced on-page SEO and Google Business integration",
          "Optional social-media embedding and blog functionality",
        ],
        description: `
          The Business package is built for companies that are outgrowing “just a website”.
          You need proper tools — quoting, booking, tracking, and automating the things
          that eat into your time. We build custom CRM systems that fit your business
          (not the other way around) so you can manage everything from one place.

          While everyone else is chasing social-media trends and overcomplicated marketing,
          we focus on what actually builds your business: visibility, credibility, and trust.
          Our job is to handle the digital side — so you can keep doing what you do best.
        `,
        visible: true,
      },
      {
        name: "Premium",
        tagline: "Complete digital systems — websites, CRMs, automation & care",
        price_oneoff: 6000,
        price_monthly: 300,
        term_months: 24,
        features: [
          "All Business features, plus:",
          "Fully bespoke CRM and workflow automation suite",
          "Online payments and recurring billing integration",
          "Customer portals with secure login and data management",
          "Automated email and SMS notifications",
          "Priority technical support and dedicated maintenance",
        ],
        description: `
          The Premium package is for serious operators who want their digital presence
          to do more than look good — it should *work hard*. This is a complete custom
          business platform built around your daily operations: from first enquiry
          to payment, automation, and follow-up.

          We combine design, CRM, automation, and ongoing strategy under one roof.
          No outsourcing, no “we’ll get back to you next week” support.
          Just a single team that knows your system inside out — and keeps it
          secure, compliant, and up-to-date with every digital trend, so you don’t
          have to.
        `,
        visible: true,
      },
    ];

    for (const pkg of packages) {
      await pool.query(
        `
        INSERT INTO packages
          (name, tagline, price_oneoff, price_monthly, term_months, features, visible, created_at, updated_at)
        VALUES
          ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW())
        RETURNING id;
        `,
        [
          pkg.name,
          pkg.tagline,
          pkg.price_oneoff,
          pkg.price_monthly,
          pkg.term_months,
          pkg.features,
          pkg.visible,
        ]
      );

      // Now attach the long description as an extra update (in case schema lacks column)
      try {
        await pool.query(
          `ALTER TABLE packages ADD COLUMN IF NOT EXISTS description TEXT`
        );
        await pool.query(
          `UPDATE packages SET description = $1 WHERE name = $2`,
          [pkg.description, pkg.name]
        );
      } catch (e) {
        console.warn(`⚠️ Could not add description column: ${e.message}`);
      }

      console.log(`✅ Inserted package: ${pkg.name}`);
    }

    console.log("🎉 Enhanced packages seeded successfully!");
  } catch (err) {
    console.error("❌ Package seeding failed:", err.message);
  } finally {
    await pool.end();
  }
}

seedPackages();
