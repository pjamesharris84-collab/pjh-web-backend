// ============================================
// PJH Web Services — Database Setup & Migrations
// ============================================

import dotenv from "dotenv";
import pkg from "pg";
import crypto from "crypto";
dotenv.config();

const { Pool } = pkg;

// -----------------------------
// 🧩 Connection Setup
// -----------------------------
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

// Lifecycle events
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

// ============================================
// 🧱 MIGRATIONS
// ============================================

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
      status VARCHAR(20) DEFAULT 'pending' CHECK (
        status IN ('pending','accepted','rejected','amend_requested')
      ),
      pricing_mode VARCHAR(20) DEFAULT 'oneoff' CHECK (
        pricing_mode IN ('oneoff','monthly')
      ),
      feedback TEXT,
      response_token VARCHAR(255) UNIQUE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

// --- Schema Patch: Ensure Columns Exist ---
async function patchQuotesTable() {
  await pool.query(`
    ALTER TABLE quotes
    ADD COLUMN IF NOT EXISTS package_id INTEGER REFERENCES packages(id) ON DELETE SET NULL;
  `);

  await pool.query(`
    ALTER TABLE quotes
    ADD COLUMN IF NOT EXISTS pricing_mode VARCHAR(20) DEFAULT 'oneoff' CHECK (
      pricing_mode IN ('oneoff','monthly')
    );
  `);
}

// --- Fix: Add missing financial columns ---
async function patchQuoteColumns() {
  await pool.query(`
    ALTER TABLE quotes
    ADD COLUMN IF NOT EXISTS custom_price NUMERIC(10,2);
  `);

  await pool.query(`
    ALTER TABLE quotes
    ADD COLUMN IF NOT EXISTS deposit NUMERIC(10,2) DEFAULT 0;
  `);

  await pool.query(`
    ALTER TABLE quotes
    ADD COLUMN IF NOT EXISTS discount_percent NUMERIC(5,2) DEFAULT 0;
  `);
}

// --- Quote History ---
async function runQuoteHistoryMigration() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS quote_history (
      id SERIAL PRIMARY KEY,
      quote_id INT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
      action VARCHAR(50) NOT NULL,
      feedback TEXT,
      actor VARCHAR(50) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
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
      status VARCHAR(20) DEFAULT 'in_progress' CHECK (
        status IN ('in_progress','completed','cancelled')
      ),
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
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

// --- Order Diary ---
async function runOrderDiaryMigration() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_diary (
      id SERIAL PRIMARY KEY,
      order_id INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      note TEXT NOT NULL,
      date TIMESTAMP DEFAULT NOW()
    );
  `);
}

// --- Payments ---
async function runPaymentMigration() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      order_id INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      amount NUMERIC(10,2) NOT NULL,
      type VARCHAR(20) CHECK (type IN ('deposit','balance','full')),
      method VARCHAR(50),
      reference VARCHAR(255),
      stripe_session_id VARCHAR(255),
      stripe_payment_intent VARCHAR(255),
      stripe_status VARCHAR(50),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

// ============================================
// 🌱 SEED DEFAULT PACKAGES
// ============================================

async function seedDefaultPackages() {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS count FROM packages");
  if (rows[0].count > 0) {
    console.log(`🌱 Packages already exist (${rows[0].count} found) — skipping seed.`);
    return;
  }

  const packages = [
    {
      name: "Starter",
      tagline: "Perfect for small business websites",
      price_oneoff: 900,
      price_monthly: 60,
      term_months: 24,
      features: [
        "4–6 custom pages",
        "Responsive design",
        "Basic SEO setup",
        "Social links",
        "Hosting setup",
      ],
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
        "On-page SEO",
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
        "Advanced automations",
        "Custom APIs",
        "Priority support",
        "SLA included",
      ],
    },
  ];

  for (const pkg of packages) {
    await pool.query(
      `
      INSERT INTO packages
      (name, tagline, price_oneoff, price_monthly, term_months, features, discount_percent, visible, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,0,TRUE,NOW(),NOW());
      `,
      [
        pkg.name,
        pkg.tagline,
        pkg.price_oneoff,
        pkg.price_monthly,
        pkg.term_months,
        pkg.features,
      ]
    );
  }

  console.log("✅ Seeded default packages successfully.");
}

// ============================================
// 🧭 Run all migrations safely
// ============================================

export async function runMigrations() {
  console.log("🚀 Running PostgreSQL migrations...");
  try {
    await pool.query("BEGIN");
    await runCustomerMigration();
    await runPackageMigration();
    await runQuoteMigration();
    await patchQuotesTable();
    await patchQuoteColumns(); // ✅ fixes custom_price and deposit columns
    await runQuoteHistoryMigration();
    await runOrderMigration();
    await runOrderDiaryMigration();
    await runPaymentMigration();
    await seedDefaultPackages();
    await pool.query("COMMIT");
    console.log("✅ All migrations + schema patches + seeding completed successfully.");
  } catch (err) {
    await pool.query("ROLLBACK").catch(() => {});
    console.error("❌ Migration error:", err.message);
  }
}

// ============================================
// 🔧 Helper Utilities
// ============================================

export function generateResponseToken() {
  return crypto.randomUUID();
}

export async function generateQuoteNumber(customerId, businessName = "Customer") {
  const safeBusiness = (businessName || "Customer")
    .replace(/[^a-zA-Z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .toUpperCase();

  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM quotes WHERE customer_id = $1`,
    [customerId]
  );

  const count = (rows[0]?.count || 0) + 1;
  return `PJH-WS/${safeBusiness}/${String(count).padStart(6, "0")}`;
}

export default pool;
