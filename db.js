/**
 * ============================================================
 * PJH Web Services — Database Setup & Migrations (2025-11)
 * ============================================================
 * Non-destructive, idempotent migrations for PostgreSQL.
 * Ensures:
 *   • All core tables exist (customers, packages, quotes, orders, payments)
 *   • Packages and maintenance_plans seeded with VAT-aligned 2025 pricing
 *   • Safe for repeated runs — no data loss
 * ============================================================
 */

import dotenv from "dotenv";
import pkg from "pg";
import crypto from "crypto";

dotenv.config();
const { Pool } = pkg;

/* ------------------------------------------------------------
   Connection Setup
------------------------------------------------------------ */
let connectionOptions;

if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim() !== "") {
  connectionOptions = {
    connectionString: process.env.DATABASE_URL.trim(),
    ssl: { rejectUnauthorized: false },
  };
  console.log("[DB] Using hosted PostgreSQL via DATABASE_URL");
} else {
  connectionOptions = {
    host: process.env.PG_HOST || "localhost",
    user: process.env.PG_USER || "postgres",
    password: process.env.PG_PASS || "",
    database: process.env.PG_DB || "pjh_web",
    port: Number(process.env.PG_PORT) || 5432,
    ssl: process.env.PG_SSL === "true" ? { rejectUnauthorized: false } : false,
  };
  console.log("[DB] Using local PostgreSQL connection");
}

export const pool = new Pool(connectionOptions);

pool.on("connect", () => console.log("[DB] Connected to PostgreSQL"));
pool.on("error", (err) => console.error("[DB] Pool Error:", err.message));

/* ------------------------------------------------------------
   Run Migrations (Non-Destructive)
------------------------------------------------------------ */
export async function runMigrations() {
  console.log("[DB] Running PostgreSQL migrations (non-destructive)…");

  try {
    await pool.query("BEGIN");

    /* ============================================================
       1️⃣ Core Tables (Customers, Packages, Quotes, Orders, Payments)
    ============================================================ */
    await pool.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id SERIAL PRIMARY KEY,
        business VARCHAR(255),
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL,
        phone VARCHAR(50),
        address1 VARCHAR(255),
        address2 VARCHAR(255),
        city VARCHAR(100),
        county VARCHAR(100),
        postcode VARCHAR(20),
        notes TEXT,
        stripe_customer_id TEXT,
        stripe_mandate_id TEXT,
        direct_debit_active BOOLEAN DEFAULT false,
        payment_method VARCHAR(50) DEFAULT 'card'
          CHECK (payment_method IN ('card','direct_debit','mixed')),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS packages (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        tagline VARCHAR(255),
        description TEXT,
        price_oneoff NUMERIC(10,2) NOT NULL,
        price_monthly NUMERIC(10,2),
        term_months INTEGER DEFAULT 24,
        features TEXT[] DEFAULT '{}',
        discount_percent NUMERIC(5,2) DEFAULT 0,
        visible BOOLEAN DEFAULT TRUE,
        pricing_guardrails JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS quotes (
        id SERIAL PRIMARY KEY,
        customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        package_id INTEGER REFERENCES packages(id) ON DELETE SET NULL,
        maintenance_id INTEGER,
        quote_number VARCHAR(255) UNIQUE,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        items JSONB NOT NULL DEFAULT '[]'::jsonb,
        deposit NUMERIC(10,2) DEFAULT 0,
        custom_price NUMERIC(10,2),
        discount_percent NUMERIC(5,2) DEFAULT 0,
        notes TEXT,
        status VARCHAR(20) DEFAULT 'pending'
          CHECK (status IN ('pending','closed')),
        pricing_mode VARCHAR(20) DEFAULT 'oneoff'
          CHECK (pricing_mode IN ('oneoff','monthly')),
        response_token VARCHAR(255) UNIQUE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        quote_id INTEGER UNIQUE REFERENCES quotes(id) ON DELETE SET NULL,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        status VARCHAR(20) DEFAULT 'in_progress'
          CHECK (status IN ('in_progress','completed','cancelled')),
        items JSONB NOT NULL DEFAULT '[]'::jsonb,
        tasks JSONB NOT NULL DEFAULT '[]'::jsonb,
        deposit NUMERIC(10,2) DEFAULT 0,
        balance NUMERIC(10,2) DEFAULT 0,
        diary JSONB NOT NULL DEFAULT '[]'::jsonb,
        deposit_invoiced BOOLEAN DEFAULT false,
        balance_invoiced BOOLEAN DEFAULT false,
        deposit_paid BOOLEAN DEFAULT false,
        balance_paid BOOLEAN DEFAULT false,
        total_paid NUMERIC(10,2) DEFAULT 0,
        recurring BOOLEAN DEFAULT false,
        recurring_amount NUMERIC(10,2),
        recurring_interval VARCHAR(20) DEFAULT 'monthly',
        recurring_active BOOLEAN DEFAULT false,
        maintenance_name VARCHAR(120),
        maintenance_monthly NUMERIC(10,2),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY,
        order_id INT REFERENCES orders(id) ON DELETE CASCADE,
        customer_id INT REFERENCES customers(id) ON DELETE SET NULL,
        amount NUMERIC(10,2) NOT NULL,
        type VARCHAR(20)
          CHECK (type IN ('deposit','balance','refund','monthly','full')),
        method VARCHAR(50),
        reference VARCHAR(255),
        notes TEXT,
        recorded_by VARCHAR(100),
        reconciled BOOLEAN DEFAULT false,
        stripe_session_id VARCHAR(255),
        stripe_payment_intent VARCHAR(255),
        stripe_event_id VARCHAR(255) UNIQUE,
        stripe_status VARCHAR(50),
        status VARCHAR(50) DEFAULT 'pending'
          CHECK (status IN ('pending','paid','failed','cancelled','refunded')),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    /* ============================================================
       2️⃣ Maintenance Tables
    ============================================================ */
    await pool.query(`
      CREATE TABLE IF NOT EXISTS maintenance_plans (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        price NUMERIC(10,2) NOT NULL,
        description TEXT,
        features TEXT[] DEFAULT '{}',
        visible BOOLEAN DEFAULT TRUE,
        sort_order INT DEFAULT 100,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS maintenance_signups (
        id SERIAL PRIMARY KEY,
        customer_name VARCHAR(150) NOT NULL,
        email VARCHAR(150) NOT NULL,
        plan_id INT REFERENCES maintenance_plans(id) ON DELETE SET NULL,
        plan_name VARCHAR(100),
        plan_price NUMERIC(10,2),
        status VARCHAR(50) DEFAULT 'pending'
          CHECK (status IN ('pending','active','cancelled','failed')),
        stripe_checkout_session_id TEXT,
        stripe_subscription_id TEXT,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    /* ============================================================
       3️⃣ Triggers
    ============================================================ */
    await pool.query(`
      CREATE OR REPLACE FUNCTION update_timestamp()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_update_orders_timestamp') THEN
          CREATE TRIGGER trg_update_orders_timestamp
          BEFORE UPDATE ON orders
          FOR EACH ROW EXECUTE FUNCTION update_timestamp();
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_update_packages_timestamp') THEN
          CREATE TRIGGER trg_update_packages_timestamp
          BEFORE UPDATE ON packages
          FOR EACH ROW EXECUTE FUNCTION update_timestamp();
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_update_maint_plans_timestamp') THEN
          CREATE TRIGGER trg_update_maint_plans_timestamp
          BEFORE UPDATE ON maintenance_plans
          FOR EACH ROW EXECUTE FUNCTION update_timestamp();
        END IF;
      END$$;
    `);

    /* ============================================================
       4️⃣ Indexes
    ============================================================ */
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id);
      CREATE INDEX IF NOT EXISTS idx_quotes_customer_id ON quotes(customer_id);
      CREATE INDEX IF NOT EXISTS idx_packages_visible ON packages(visible);
      CREATE INDEX IF NOT EXISTS idx_maint_plans_visible ON maintenance_plans(visible, sort_order);
    `);

    /* ============================================================
       5️⃣ Default Data Seeding (Only If Empty)
    ============================================================ */

    // Packages
    const { rows: pkgCountRows } = await pool.query(
      "SELECT COUNT(*)::int AS c FROM packages;"
    );

    if ((pkgCountRows?.[0]?.c ?? 0) === 0) {
      const packagesSeed = [
        {
          name: "Starter",
          tagline: "Bespoke 5-page website — no templates, no jargon.",
          description:
            "A handcrafted online presence for local businesses — built from scratch, fast, secure, and Google-friendly.",
          price_oneoff: 795,
          price_monthly: 49,
          term_months: 24,
          features: [
            "5 bespoke, custom-designed pages",
            "Responsive & SEO-optimised",
            "Google Maps & Business Profile integration",
            "Secure UK hosting + SSL (12 months included)",
            "Contact form with spam protection",
            "Basic WebCare maintenance",
          ],
        },
        {
          name: "Business",
          tagline: "For growing companies — CRM, quoting & automation built in.",
          description:
            "Bespoke website + integrated CRM tools for leads, jobs, quotes, and invoicing — built around your workflow.",
          price_oneoff: 1495,
          price_monthly: 85,
          term_months: 24,
          features: [
            "All Starter features included",
            "Custom CRM dashboard (leads, clients & jobs)",
            "Integrated quoting & invoicing",
            "Automated email replies & smart forms",
            "Booking forms / scheduling",
            "Analytics & local SEO setup",
          ],
        },
        {
          name: "Premium",
          tagline: "Our flagship automation suite — bookings, payments & portals.",
          description:
            "A complete digital platform: bespoke CRM, automation, client portals, billing, and analytics.",
          price_oneoff: 2950,
          price_monthly: 160,
          term_months: 24,
          features: [
            "All Business features included",
            "Bespoke CRM & project management",
            "Online bookings, payments & subscriptions",
            "Client portal (secure access)",
            "Automated invoicing & reminders",
            "Priority WebCare support",
          ],
        },
      ];

      for (const p of packagesSeed) {
        await pool.query(
          `
          INSERT INTO packages
            (name, tagline, description, price_oneoff, price_monthly, term_months, features, visible, created_at, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,NOW(),NOW());
          `,
          [
            p.name,
            p.tagline,
            p.description,
            p.price_oneoff,
            p.price_monthly,
            p.term_months,
            p.features,
          ]
        );
      }
      console.log("[DB] Default packages seeded.");
    }

    // Maintenance Plans
    const { rows: mpCountRows } = await pool.query(
      "SELECT COUNT(*)::int AS c FROM maintenance_plans;"
    );

    if ((mpCountRows?.[0]?.c ?? 0) === 0) {
      const plans = [
        {
          name: "Essential Care",
          price: 45,
          description:
            "Perfect for small brochure or Starter websites. Monthly updates, daily backups, and essential uptime monitoring.",
          features: [
            "Monthly plugin & core updates",
            "Daily backups (7-day retention)",
            "Basic uptime & security monitoring",
            "Email support within 2 business days",
            "Annual payment option (£420 + VAT / £504 inc.)",
          ],
          sort_order: 10,
        },
        {
          name: "WebCare Plus",
          price: 85,
          description:
            "Ideal for growing sites needing regular updates, SEO checks, and faster support turnaround.",
          features: [
            "Bi-weekly updates & security scans",
            "Daily backups (14-day retention)",
            "Monthly performance report",
            "Priority same-day email support",
            "Annual payment option (£900 + VAT / £1,080 inc.)",
          ],
          sort_order: 20,
        },
        {
          name: "WebCare Premium",
          price: 145,
          description:
            "For ecommerce or CRM-driven sites needing performance tuning, SEO audits, and priority fixes.",
          features: [
            "Weekly updates & deep security scans",
            "Real-time uptime monitoring",
            "Monthly performance & SEO audit",
            "Priority phone & email support",
            "Annual payment option (£1,560 + VAT / £1,872 inc.)",
          ],
          sort_order: 30,
        },
      ];

      for (const p of plans) {
        await pool.query(
          `
          INSERT INTO maintenance_plans
            (name, price, description, features, visible, sort_order, created_at, updated_at)
          VALUES ($1,$2,$3,$4,TRUE,$5,NOW(),NOW());
          `,
          [p.name, p.price, p.description, p.features, p.sort_order]
        );
      }
      console.log("[DB] Default maintenance plans seeded (VAT 2025 pricing).");
    }

    await pool.query("COMMIT");
    console.log("[DB] ✅ Migrations complete — schema and seed data up-to-date.");
  } catch (err) {
    await pool.query("ROLLBACK").catch(() => {});
    console.error("[DB] Migration error:", err.message);
  }
}

/* ------------------------------------------------------------
   Utility Functions
------------------------------------------------------------ */
export async function generateQuoteNumber(customerId, businessName = "Customer") {
  const safeName = (businessName || "Customer")
    .replace(/[^a-zA-Z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .toUpperCase();

  const { rows } = await pool.query(
    "SELECT COUNT(*)::int AS c FROM quotes WHERE customer_id=$1;",
    [customerId]
  );
  const count = (rows?.[0]?.c || 0) + 1;
  return `PJH-WS/${safeName}/${String(count).padStart(6, "0")}`;
}

export function generateResponseToken() {
  return crypto.randomUUID();
}

export default pool;
