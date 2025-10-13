/**
 * ============================================================
 * PJH Web Services — Package Seeder Script (2025 Refined)
 * ============================================================
 * Populates the `packages` table with realistic, honest website
 * packages that match PJH Web Services’ bespoke approach.
 *
 * Includes:
 *  • Starter  — bespoke 5-page design, SEO, hosting & WebCare
 *  • Business — full CRM, automation & growth systems
 *  • Premium  — full automation suite with payments & portals
 * ------------------------------------------------------------
 * Each entry reflects your brand tone:
 *   • No templates
 *   • No jargon
 *   • Trend-aware, performance-driven web design
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

    console.log("📦 Seeding refined 2025 packages…");

    const packages = [
      {
        name: "Starter",
        tagline: "Bespoke 5-page website — no templates, no jargon.",
        price_oneoff: 795,
        price_monthly: 49,
        term_months: 24,
        features: [
          "5 fully bespoke, custom-designed pages",
          "Responsive design optimised for mobile & Google search",
          "Local SEO setup with Google Maps & Business Profile integration",
          "Secure UK-based hosting & SSL certificate (first 12 months included)",
          "Contact form with direct email delivery & spam protection",
          "Basic WebCare maintenance: updates, backups & two content edits per year",
        ],
        description: `
          The Starter Package gives local tradesmen, shops, and sole traders a truly bespoke
          online presence — designed from scratch, not templates. It’s perfect for small
          businesses that want to look professional, appear on Google, and attract real customers.

          Every build is crafted around your goals, with fast performance, mobile optimisation,
          and secure hosting included. We cut through the buzzwords and deliver a clean, modern
          website that does exactly what it should — get you more local enquiries.
        `,
        visible: true,
      },
      {
        name: "Business",
        tagline: "For growing companies — built-in CRM, quoting & automation.",
        price_oneoff: 1495,
        price_monthly: 85,
        term_months: 24,
        features: [
          "All Starter features included",
          "Custom CRM dashboard for leads, clients & job tracking",
          "Integrated quoting and invoicing system",
          "Automated email replies & smart enquiry handling",
          "Booking forms and scheduling tools",
          "Google Analytics & Search Console integration",
          "On-page SEO setup with local keyword targeting",
          "12 months of hosting, SSL & WebCare included",
        ],
        description: `
          The Business Package is built for companies that have outgrown a simple brochure site.
          We combine a fully bespoke design with integrated CRM tools to manage leads, quotes,
          jobs, and invoices — all from one place.

          Every system is built around your workflow — not a template. With automation, analytics,
          and SEO all built in, this package gives you the tools to scale efficiently without
          drowning in admin. We handle the digital side so you can focus on running your business.
        `,
        visible: true,
      },
      {
        name: "Premium",
        tagline:
          "Our flagship automation suite — CRM, bookings, payments & client portals.",
        price_oneoff: 2950,
        price_monthly: 160,
        term_months: 24,
        features: [
          "All Business features included",
          "Fully bespoke CRM & project management system",
          "Online bookings, payments & recurring billing (Stripe / GoCardless)",
          "Client login portal with secure data access",
          "Automated invoicing, reminders & follow-ups",
          "Advanced analytics & performance dashboard",
          "Team roles, access control & multi-user management",
          "Priority WebCare Premium maintenance & support included",
        ],
        description: `
          The Premium Package is a complete digital platform for established businesses that
          want their website to handle everything — from client onboarding and payments to
          ongoing automation.

          We design and build a custom CRM and automation suite that fits your operations
          exactly — integrating bookings, invoices, reminders, and analytics in one unified
          system. Built from scratch, maintained by us, and always kept ahead of digital trends,
          this is the ultimate all-in-one business platform.
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

    console.log("🎉 Refined packages seeded successfully!");
  } catch (err) {
    console.error("❌ Package seeding failed:", err.message);
  } finally {
    await pool.end();
  }
}

seedPackages();
