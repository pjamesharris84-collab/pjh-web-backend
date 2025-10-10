/**
 * ============================================================
 * PJH Web Services — Database Setup & Migrations (2025 Stable)
 * ============================================================
 * Handles:
 *   • Safe migrations with no data loss
 *   • Auto column/constraint repair (plan_id, visible)
 *   • Default package + maintenance plan seeding
 *   • Timestamp triggers + indexing
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
   Main Migration Logic
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
       2️⃣  Backfill / Patch Legacy Schemas
    ============================================================ */
    await pool.query(`
      DO $$
      BEGIN
        -- packages.visible
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='packages' AND column_name='visible'
        ) THEN
          ALTER TABLE packages ADD COLUMN visible BOOLEAN DEFAULT TRUE;
        END IF;

        -- maintenance_plans.visible
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='maintenance_plans' AND column_name='visible'
        ) THEN
          ALTER TABLE maintenance_plans ADD COLUMN visible BOOLEAN DEFAULT TRUE;
        END IF;

        -- maintenance_signups.plan_id
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='maintenance_signups' AND column_name='plan_id'
        ) THEN
          ALTER TABLE maintenance_signups ADD COLUMN plan_id INT;
          ALTER TABLE maintenance_signups
            ADD CONSTRAINT maintenance_signups_plan_id_fkey
            FOREIGN KEY (plan_id) REFERENCES maintenance_plans(id) ON DELETE SET NULL;
        END IF;
      END$$;
    `);

    console.log("[DB] Legacy column patching done.");

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

        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_update_maint_signups_timestamp') THEN
          CREATE TRIGGER trg_update_maint_signups_timestamp
          BEFORE UPDATE ON maintenance_signups
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
      CREATE INDEX IF NOT EXISTS idx_maint_signups_plan_id ON maintenance_signups(plan_id);
    `);

    console.log("[DB] Indexes ensured.");

    /* ============================================================
       5️⃣  Default Data Seeding (if empty)
    ============================================================ */
    const { rows: pkgRows } = await pool.query("SELECT COUNT(*)::int AS c FROM packages;");
    if ((pkgRows?.[0]?.c ?? 0) === 0) {
      const defaults = [
        {
          name: "Starter",
          tagline: "Perfect for small business websites",
          price_oneoff: 900,
          price_monthly: 60,
          term_months: 24,
          features: ["4–6 pages", "Responsive design", "Basic SEO", "Hosting setup"],
        },
        {
          name: "Business",
          tagline: "For growing companies needing automation",
          price_oneoff: 2600,
          price_monthly: 140,
          term_months: 24,
          features: ["All Starter features", "Booking system", "Invoicing tools", "CRM core"],
        },
        {
          name: "Premium",
          tagline: "Full bespoke CRM + integrations",
          price_oneoff: 6000,
          price_monthly: 300,
          term_months: 24,
          features: ["All Business features", "Custom APIs", "Automations", "Priority support"],
        },
      ];

      for (const p of defaults) {
        await pool.query(
          `INSERT INTO packages
           (name, tagline, price_oneoff, price_monthly, term_months, features, discount_percent, visible, pricing_guardrails)
           VALUES ($1,$2,$3,$4,$5,$6,0,TRUE,'{}'::jsonb);`,
          [p.name, p.tagline, p.price_oneoff, p.price_monthly, p.term_months, p.features]
        );
      }
      console.log("[DB] Default packages seeded.");
    }

    const { rows: planRows } = await pool.query("SELECT COUNT(*)::int AS c FROM maintenance_plans;");
    if ((planRows?.[0]?.c ?? 0) === 0) {
      const plans = [
        {
          name: "Essential Care",
          price: 45,
          description: "Core updates, backups, and security monitoring.",
          features: [
            "Weekly backups",
            "CMS & plugin updates",
            "Security scans",
            "Uptime monitoring",
          ],
          sort_order: 10,
        },
        {
          name: "Performance Care",
          price: 95,
          description: "Performance, SEO, and reporting for growing businesses.",
          features: [
            "Everything in Essential",
            "Speed optimisation",
            "SEO health check",
            "Monthly report",
          ],
          sort_order: 20,
        },
        {
          name: "Total WebCare",
          price: 195,
          description: "Full service for mission-critical sites with priority support.",
          features: [
            "Everything in Performance",
            "3 hrs monthly updates",
            "Priority support (24h)",
            "Emergency fixes included",
          ],
          sort_order: 30,
        },
      ];
      for (const p of plans) {
        await pool.query(
          `INSERT INTO maintenance_plans
           (name, price, description, features, visible, sort_order)
           VALUES ($1,$2,$3,$4,TRUE,$5);`,
          [p.name, p.price, p.description, p.features, p.sort_order]
        );
      }
      console.log("[DB] Default maintenance plans seeded.");
    }

    await pool.query("COMMIT");
    console.log("[DB] ✅ Migrations complete — no data lost.");
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
