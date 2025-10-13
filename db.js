/**
 * ============================================================
 * PJH Web Services — Database Setup & Migrations (2025-10)
 * ============================================================
 * Non-destructive, idempotent migrations for PostgreSQL.
 * Ensures:
 *   • All core tables exist (customers, packages, quotes, orders, payments)
 *   • New columns: packages.description, packages.pricing_guardrails
 *   • quotes.maintenance_id, orders.maintenance_name/_monthly
 *   • Timestamp triggers, helpful indexes
 *   • Default seed data (packages, maintenance plans) if empty
 * ============================================================
 */

import dotenv from "dotenv";
import pkg from "pg";
import crypto from "crypto";

dotenv.config();
const { Pool } = pkg;

/* ------------------------------------------------------------
   Connection Setup (Hosted or Local)
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
   Main Migration Logic (Idempotent / Non-Destructive)
------------------------------------------------------------ */
export async function runMigrations() {
  console.log("[DB] Running PostgreSQL migrations (non-destructive)…");

  try {
    await pool.query("BEGIN");

    /* ============================================================
       1️⃣  Core Tables (Create If Missing)
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
        description TEXT,                                  -- ✅ new (fixes 500)
        price_oneoff NUMERIC(10,2) NOT NULL,
        price_monthly NUMERIC(10,2),
        term_months INTEGER DEFAULT 24,
        features TEXT[] DEFAULT '{}',
        discount_percent NUMERIC(5,2) DEFAULT 0,
        visible BOOLEAN DEFAULT TRUE,
        pricing_guardrails JSONB DEFAULT '{}'::jsonb,      -- ✅ guardrails support
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS quotes (
        id SERIAL PRIMARY KEY,
        customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        package_id INTEGER REFERENCES packages(id) ON DELETE SET NULL,
        maintenance_id INTEGER,                             -- ✅ link to maintenance_plans
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
        -- Invoicing / payment flags
        deposit_invoiced BOOLEAN DEFAULT false,
        balance_invoiced BOOLEAN DEFAULT false,
        deposit_paid BOOLEAN DEFAULT false,
        balance_paid BOOLEAN DEFAULT false,
        total_paid NUMERIC(10,2) DEFAULT 0,
        -- Recurring (legacy support)
        recurring BOOLEAN DEFAULT false,
        recurring_amount NUMERIC(10,2),
        recurring_interval VARCHAR(20) DEFAULT 'monthly',
        recurring_active BOOLEAN DEFAULT false,
        -- ✅ Maintenance snapshot on order
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

      /* =======================================
         Maintenance Plans & Signups
         ======================================= */
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

    console.log("[DB] Core tables verified/created.");

    /* ============================================================
       2️⃣  Column Backfills / Patching (Safe IF NOT EXISTS)
    ============================================================ */
    await pool.query(`
      DO $$
      BEGIN
        -- packages.description
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='packages' AND column_name='description'
        ) THEN
          ALTER TABLE packages ADD COLUMN description TEXT;
        END IF;

        -- packages.pricing_guardrails
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='packages' AND column_name='pricing_guardrails'
        ) THEN
          ALTER TABLE packages ADD COLUMN pricing_guardrails JSONB DEFAULT '{}'::jsonb;
        END IF;

        -- quotes.maintenance_id
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='quotes' AND column_name='maintenance_id'
        ) THEN
          ALTER TABLE quotes ADD COLUMN maintenance_id INTEGER;
        END IF;

        -- orders.maintenance_name
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='orders' AND column_name='maintenance_name'
        ) THEN
          ALTER TABLE orders ADD COLUMN maintenance_name VARCHAR(120);
        END IF;

        -- orders.maintenance_monthly
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='orders' AND column_name='maintenance_monthly'
        ) THEN
          ALTER TABLE orders ADD COLUMN maintenance_monthly NUMERIC(10,2);
        END IF;

        -- packages.visible (legacy)
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='packages' AND column_name='visible'
        ) THEN
          ALTER TABLE packages ADD COLUMN visible BOOLEAN DEFAULT TRUE;
        END IF;

        -- maintenance_plans.visible (legacy)
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='maintenance_plans' AND column_name='visible'
        ) THEN
          ALTER TABLE maintenance_plans ADD COLUMN visible BOOLEAN DEFAULT TRUE;
        END IF;
      END$$;
    `);

    console.log("[DB] Legacy/patch columns ensured.");

    /* ============================================================
       3️⃣  Timestamp Triggers
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

        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_update_customers_timestamp') THEN
          CREATE TRIGGER trg_update_customers_timestamp
          BEFORE UPDATE ON customers
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

        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_update_quotes_timestamp') THEN
          CREATE TRIGGER trg_update_quotes_timestamp
          BEFORE UPDATE ON quotes
          FOR EACH ROW EXECUTE FUNCTION update_timestamp();
        END IF;
      END$$;
    `);

    /* ============================================================
       4️⃣  Index Optimisation
    ============================================================ */
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id);
      CREATE INDEX IF NOT EXISTS idx_quotes_customer_id ON quotes(customer_id);
      CREATE INDEX IF NOT EXISTS idx_packages_visible ON packages(visible);
      CREATE INDEX IF NOT EXISTS idx_maint_plans_visible ON maintenance_plans(visible, sort_order);
      CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes(status);
      CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    `);

    console.log("[DB] Indexes ensured.");

    /* ============================================================
       5️⃣  Default Data Seeding (Only If Empty)
    ============================================================ */

    // Packages
    const { rows: pkgCountRows } = await pool.query(
      "SELECT COUNT(*)::int AS c FROM packages;"
    );
    if ((pkgCountRows?.[0]?.c ?? 0) === 0) {
      const guardrailsDefault = {
        require_deposit_months: 1,
        min_term_months: 24,
        early_exit_fee_pct: 35,
        ownership_until_paid: true,
        late_fee_pct: 5,
        default_payment_method: "direct_debit",
        tcs_version: "2025-10",
      };

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
          tagline:
            "Our flagship automation suite — bookings, payments & client portals.",
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
            (name, tagline, description, price_oneoff, price_monthly, term_months,
             features, discount_percent, visible, pricing_guardrails, created_at, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,0,TRUE,$8::jsonb,NOW(),NOW());
          `,
          [
            p.name,
            p.tagline,
            p.description,
            p.price_oneoff,
            p.price_monthly,
            p.term_months,
            p.features,
            JSON.stringify(guardrailsDefault),
          ]
        );
      }
      console.log("[DB] Default packages seeded.");
    }

    // Maintenance plans
    const { rows: mpCountRows } = await pool.query(
      "SELECT COUNT(*)::int AS c FROM maintenance_plans;"
    );
    if ((mpCountRows?.[0]?.c ?? 0) === 0) {
      const plans = [
        {
          name: "Essential Care",
          price: 45,
          description:
            "Basic protection for small business sites — backups, updates, security & uptime checks.",
          features: [
            "Weekly backups & plugin updates",
            "Security & uptime monitoring",
            "Malware protection & SSL renewal",
            "Email support (within 48h)",
          ],
          sort_order: 10,
        },
        {
          name: "Performance Care",
          price: 95,
          description:
            "Proactive care with speed monitoring, SEO health checks, and monthly reporting.",
          features: [
            "All Essential features included",
            "Monthly SEO & performance audit",
            "Speed & mobile optimisation checks",
            "1 hour of content edits per month",
            "Priority support within 48h",
          ],
          sort_order: 20,
        },
        {
          name: "Total WebCare",
          price: 195,
          description:
            "Complete WebCare — edits, analytics, reports, strategy calls and emergency fixes.",
          features: [
            "All Performance features included",
            "3 hours of monthly content updates",
            "Analytics dashboard access",
            "Quarterly strategy call",
            "Emergency fixes included",
            "Priority support within 24h",
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
      console.log("[DB] Default maintenance plans seeded.");
    }

    await pool.query("COMMIT");
    console.log("[DB] ✅ Migrations complete — schema up-to-date, no data lost.");
  } catch (err) {
    await pool.query("ROLLBACK").catch(() => {});
    console.error("[DB] Migration error:", err.message);
  }
}

/* ------------------------------------------------------------
   Utilities
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
