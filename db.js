/**
 * ============================================================
 * PJH Web Services — Database Setup & Migrations (Fixed Version)
 * ============================================================
 * Centralised PostgreSQL pool setup and schema management.
 * Handles:
 *   • Initial migrations
 *   • Schema patching
 *   • Default package seeding
 *   • Stripe Direct Debit + recurring payment tracking
 * ============================================================
 */

import dotenv from "dotenv";
import pkg from "pg";
import crypto from "crypto";
dotenv.config();

const { Pool } = pkg;

/* ------------------------------------------------------------
   🧩 CONNECTION SETUP
------------------------------------------------------------ */
let connectionOptions;

if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim() !== "") {
  connectionOptions = {
    connectionString: process.env.DATABASE_URL.trim(),
    ssl: { rejectUnauthorized: false },
  };
  console.log("🔌 Using hosted PostgreSQL via DATABASE_URL");
} else {
  connectionOptions = {
    host: process.env.PG_HOST || "localhost",
    user: process.env.PG_USER || "postgres",
    password: process.env.PG_PASS || "",
    database: process.env.PG_DB || "pjh_web",
    port: process.env.PG_PORT || 5432,
    ssl: process.env.PG_SSL === "true" ? { rejectUnauthorized: false } : false,
  };
  console.log("🧩 Using local PostgreSQL connection");
}

export const pool = new Pool(connectionOptions);

/* ------------------------------------------------------------
   🧠 LIFECYCLE EVENTS
------------------------------------------------------------ */
pool.on("connect", () => {
  const host = process.env.DATABASE_URL
    ? process.env.DATABASE_URL.split("@")[1]?.split(":")[0]?.replace("/", "") ||
      "Render DB"
    : process.env.PG_HOST || "localhost";
  console.log(`📦 Connected to PostgreSQL (${host})`);
});

pool.on("error", (err) => {
  console.error("❌ PostgreSQL Pool Error:", err.message);
});

/* ------------------------------------------------------------
   🧱 MIGRATIONS
------------------------------------------------------------ */

// --- Customers ---
async function runCustomerMigration() {
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
  `);
}

// --- Packages ---
async function runPackageMigration() {
  await pool.query(`
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
  `);
}

// --- Quotes ---
async function runQuoteMigration() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS quotes (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      package_id INTEGER REFERENCES packages(id) ON DELETE SET NULL,
      quote_number VARCHAR(255) UNIQUE,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      items JSONB NOT NULL DEFAULT '[]',
      deposit NUMERIC(10,2) NOT NULL DEFAULT 0,
      custom_price NUMERIC(10,2),
      discount_percent NUMERIC(5,2) DEFAULT 0,
      notes TEXT,
      status VARCHAR(20) DEFAULT 'pending'
        CHECK (status IN ('pending','accepted','rejected','amend_requested')),
      pricing_mode VARCHAR(20) DEFAULT 'oneoff'
        CHECK (pricing_mode IN ('oneoff','monthly')),
      feedback TEXT,
      response_token VARCHAR(255) UNIQUE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

// --- Orders ---
async function runOrderMigration() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      quote_id INTEGER UNIQUE REFERENCES quotes(id) ON DELETE SET NULL,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      status VARCHAR(20) DEFAULT 'in_progress'
        CHECK (status IN ('in_progress','completed','cancelled')),
      items JSONB NOT NULL DEFAULT '[]',
      tasks JSONB NOT NULL DEFAULT '[]',
      deposit NUMERIC(10,2) DEFAULT 0,
      balance NUMERIC(10,2) DEFAULT 0,
      diary JSONB NOT NULL DEFAULT '[]',
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
  `);
}

// --- Payments ---
async function runPaymentMigration() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      order_id INT REFERENCES orders(id) ON DELETE CASCADE,
      customer_id INT REFERENCES customers(id) ON DELETE SET NULL,
      amount NUMERIC(10,2) NOT NULL,
      type VARCHAR(20)
        CHECK (type IN ('deposit','balance','full','monthly')),
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

  // 🩹 Ensure 'status' column exists in existing Render DBs
  const check = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'payments' AND column_name = 'status';
  `);

  if (check.rows.length === 0) {
    console.log("🩹 Patching: adding missing 'status' column to payments...");
    await pool.query(`
      ALTER TABLE payments
      ADD COLUMN status VARCHAR(50) DEFAULT 'pending'
      CHECK (status IN ('pending','paid','failed','cancelled','refunded'));
    `);
    console.log("✅ 'status' column added successfully.");
  }
}

/* ------------------------------------------------------------
   🌱 SEED DEFAULT PACKAGES
------------------------------------------------------------ */
async function seedDefaultPackages() {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS count FROM packages");
  if (rows[0].count > 0) {
    console.log(`🌱 Packages already exist (${rows[0].count}) — skipping seed.`);
    return;
  }

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
      features: [
        "All Starter features",
        "Booking system",
        "Invoicing tools",
        "CRM core",
      ],
    },
    {
      name: "Premium",
      tagline: "Full bespoke CRM + integrations",
      price_oneoff: 6000,
      price_monthly: 300,
      term_months: 24,
      features: [
        "All Business features",
        "Custom APIs",
        "Automations",
        "Priority support",
      ],
    },
  ];

  for (const pkg of defaults) {
    const guardrails = {
      require_deposit_months: 1,
      min_term_months: pkg.term_months,
      early_exit_fee_pct: 40,
      ownership_until_paid: true,
      late_fee_pct: 5,
      default_payment_method: "direct_debit",
      tcs_version: "2025-01",
    };

    await pool.query(
      `INSERT INTO packages
       (name, tagline, price_oneoff, price_monthly, term_months, features, discount_percent, visible, pricing_guardrails)
       VALUES ($1,$2,$3,$4,$5,$6,0,TRUE,$7::jsonb);`,
      [
        pkg.name,
        pkg.tagline,
        pkg.price_oneoff,
        pkg.price_monthly,
        pkg.term_months,
        pkg.features,
        JSON.stringify(guardrails),
      ]
    );
  }

  console.log("✅ Seeded default packages successfully.");
}

/* ------------------------------------------------------------
   🧭 RUN ALL MIGRATIONS
------------------------------------------------------------ */
export async function runMigrations() {
  console.log("🚀 Running PostgreSQL migrations...");
  try {
    await pool.query("BEGIN");
    await runCustomerMigration();
    await runPackageMigration();
    await runQuoteMigration();
    await runOrderMigration();
    await runPaymentMigration(); // includes self-healing patch
    await seedDefaultPackages();
    await pool.query("COMMIT");
    console.log("✅ Migrations + patches completed successfully.");
  } catch (err) {
    await pool.query("ROLLBACK").catch(() => {});
    console.error("❌ Migration error:", err.message);
  }
}

/* ------------------------------------------------------------
   🔧 UTILITIES
------------------------------------------------------------ */
export function generateResponseToken() {
  return crypto.randomUUID();
}

export async function generateQuoteNumber(customerId, businessName = "Customer") {
  const safeBusiness = (businessName || "Customer")
    .replace(/[^a-zA-Z0-9\\s-]/g, "")
    .replace(/\\s+/g, "-")
    .toUpperCase();

  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM quotes WHERE customer_id = $1`,
    [customerId]
  );

  const count = (rows[0]?.count || 0) + 1;
  return `PJH-WS/${safeBusiness}/${String(count).padStart(6, "0")}`;
}

export default pool;
