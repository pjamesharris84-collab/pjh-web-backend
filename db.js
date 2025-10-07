// ============================================
// PostgreSQL Database Setup & Migration Helpers
// ============================================

import dotenv from "dotenv";
import pkg from "pg";
import crypto from "crypto";
dotenv.config();

const { Pool } = pkg;

// -----------------------------
// Pool Connection Configuration
// -----------------------------

let connectionOptions;

if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim() !== "") {
  // ✅ Preferred: Render / Railway / Supabase style single URL
  connectionOptions = {
    connectionString: process.env.DATABASE_URL.trim(),
    ssl: { rejectUnauthorized: false },
  };
  console.log("🔌 Using connection string: Render/Hosted DATABASE_URL detected");
} else {
  // ✅ Fallback for local development
  connectionOptions = {
    host: process.env.PG_HOST || "localhost",
    user: process.env.PG_USER || "postgres",
    password: process.env.PG_PASS || "",
    database: process.env.PG_DB || "pjh_web",
    port: process.env.PG_PORT || 5432,
    ssl: process.env.PG_SSL === "true" ? { rejectUnauthorized: false } : false,
  };
  console.log("🧩 Using local PostgreSQL connection (no DATABASE_URL found)");
}

export const pool = new Pool(connectionOptions);

pool.on("connect", () => {
  const host = process.env.DATABASE_URL
    ? process.env.DATABASE_URL.split("@")[1]?.split(":")[0]?.replace("/", "") || "Render DB"
    : process.env.PG_HOST || "localhost";
  console.log(`📦 Connected to PostgreSQL database (${host})`);
});

pool.on("error", (err) =>
  console.error("❌ PostgreSQL Pool Error:", err.message)
);

// ============================================
// MIGRATIONS (Run Once at Server Startup)
// ============================================

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
      notes TEXT
    );
  `);
}

async function runQuoteMigration() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS quotes (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      quote_number VARCHAR(255) UNIQUE,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      items JSONB NOT NULL DEFAULT '[]',
      deposit NUMERIC(10,2) NOT NULL DEFAULT 0,
      notes TEXT,
      status VARCHAR(20) DEFAULT 'pending' CHECK (
        status IN ('pending','accepted','rejected','amend_requested')
      ),
      feedback TEXT,
      response_token VARCHAR(255) UNIQUE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

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
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

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

async function runPaymentMigration() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      order_id INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      amount NUMERIC(10,2) NOT NULL,
      type VARCHAR(20) CHECK (type IN ('deposit','balance','full')),
      method VARCHAR(50),
      reference VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}


// ============================================
// Run all migrations safely
// ============================================

export async function runMigrations() {
  console.log("🚀 Running PostgreSQL migrations...");

  try {
    // Prevent duplicate migration runs in concurrent boots
    await pool.query(`
      CREATE TABLE IF NOT EXISTS migration_lock (
        id INT PRIMARY KEY DEFAULT 1,
        locked BOOLEAN DEFAULT TRUE
      );
    `);

    await pool.query("BEGIN");
    await runCustomerMigration();
    await runQuoteMigration();
    await runQuoteHistoryMigration();
    await runOrderMigration();
    await runOrderDiaryMigration();
    await runPaymentMigration();
    await pool.query("COMMIT");

    console.log("✅ All database migrations completed successfully.");
  } catch (err) {
    await pool.query("ROLLBACK").catch(() => {});
    console.error("❌ Migration error:", err.message);
  }
}

// ============================================
// Helper Utilities
// ============================================

export function generateResponseToken() {
  return crypto.randomUUID();
}

export async function generateQuoteNumber(
  customerId,
  businessName = "Customer"
) {
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
