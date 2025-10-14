/**
 * ============================================================
 * PJH Web Services — Quotes API (2025-10 Refined + Synced)
 * ============================================================
 * Streamlined quoting + order creation pipeline.
 *
 * Key Enhancements:
 *  ✅ Live sync with packages & maintenance plans (accurate pricing)
 *  ✅ Automatic population of maintenance_monthly + monthly_amount
 *  ✅ Auto-create order with full billing info — no manual DB edits
 *  ✅ Includes DELETE endpoints for both admin & customers
 *  ✅ Works seamlessly with Direct Debit + automation billing flows
 * ============================================================
 */

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import pool, { generateQuoteNumber } from "../db.js";
import { generateResponseToken } from "../utils/token.js";
import { sendEmail } from "../utils/email.js";
import { generateQuotePDF } from "../utils/pdf.js";
import { toArray, calcSubtotal, findQuote } from "../utils/quotes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const quotesCustomerRouter = express.Router();
export const quotesAdminRouter = express.Router();

/* ============================================================
   CUSTOMER ROUTES
   ============================================================ */

// ➕ Create Quote (Customer)
quotesCustomerRouter.post("/:id/quotes", async (req, res) => {
  const { id } = req.params;
  const {
    title,
    description,
    items,
    deposit,
    notes,
    package_id,
    maintenance_id,
    custom_price,
    discount_percent,
  } = req.body;

  try {
    const { rows: cRows } = await pool.query("SELECT * FROM customers WHERE id=$1", [id]);
    if (!cRows.length)
      return res.status(404).json({ success: false, error: "Customer not found." });

    const quoteNumber = await generateQuoteNumber(id, cRows[0].business || cRows[0].name);

    // 🔍 Pull live package + maintenance plan data
    const pkg = package_id
      ? (
          await pool.query(
            "SELECT name, price_oneoff, price_monthly FROM packages WHERE id=$1",
            [package_id]
          )
        ).rows[0]
      : null;

    const maint = maintenance_id
      ? (
          await pool.query("SELECT name, price FROM maintenance_plans WHERE id=$1", [maintenance_id])
        ).rows[0]
      : null;

    // 💾 Insert quote
    const { rows } = await pool.query(
      `
      INSERT INTO quotes (
        customer_id, quote_number, title, description, items, deposit, notes,
        package_id, maintenance_id, custom_price, discount_percent, status, response_token,
        created_at, updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12,NOW(),NOW())
      RETURNING *;
      `,
      [
        id,
        quoteNumber,
        title || "",
        description || "",
        JSON.stringify(toArray(items)),
        deposit ?? null,
        notes || "",
        package_id || null,
        maintenance_id || null,
        custom_price || null,
        discount_percent || 0,
        generateResponseToken(),
      ]
    );

    console.log(`📝 Quote created for customer ${id}: ${quoteNumber}`);
    res.status(201).json({
      success: true,
      message: "Quote created successfully.",
      quote: {
        ...rows[0],
        package_name: pkg?.name,
        maintenance_name: maint?.name,
      },
    });
  } catch (err) {
    console.error("❌ Error creating quote:", err);
    res.status(500).json({ success: false, error: "Failed to create quote." });
  }
});

// 📋 List Quotes (Customer)
quotesCustomerRouter.get("/:id/quotes", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT q.*, p.name AS package_name, m.name AS maintenance_name
      FROM quotes q
      LEFT JOIN packages p ON q.package_id = p.id
      LEFT JOIN maintenance_plans m ON q.maintenance_id = m.id
      WHERE q.customer_id=$1
      ORDER BY q.created_at DESC;
      `,
      [req.params.id]
    );
    res.json({
      success: true,
      quotes: rows.map((q) => ({ ...q, items: toArray(q.items) })),
    });
  } catch (err) {
    console.error("❌ Error fetching quotes:", err);
    res.status(500).json({ success: false, error: "Failed to fetch quotes." });
  }
});

// 🧾 Get Single Quote (Customer)
quotesCustomerRouter.get("/:id/quotes/:quoteId", async (req, res) => {
  const { id, quoteId } = req.params;
  try {
    const { rows } = await pool.query(
      `
      SELECT q.*, p.name AS package_name, m.name AS maintenance_name, m.price AS maintenance_price
      FROM quotes q
      LEFT JOIN packages p ON q.package_id = p.id
      LEFT JOIN maintenance_plans m ON q.maintenance_id = m.id
      WHERE q.id=$1 AND q.customer_id=$2;
      `,
      [quoteId, id]
    );

    if (!rows.length)
      return res.status(404).json({ success: false, error: "Quote not found." });

    res.json({ success: true, quote: { ...rows[0], items: toArray(rows[0].items) } });
  } catch (err) {
    console.error("❌ Error fetching quote:", err);
    res.status(500).json({ success: false, error: "Failed to fetch quote." });
  }
});

// ❌ Delete Quote (Customer)
quotesCustomerRouter.delete("/:id/quotes/:quoteId", async (req, res) => {
  const { quoteId, id } = req.params;
  try {
    const { rowCount } = await pool.query(
      "DELETE FROM quotes WHERE id=$1 AND customer_id=$2;",
      [quoteId, id]
    );
    if (rowCount === 0)
      return res.status(404).json({ success: false, error: "Quote not found or already deleted." });

    console.log(`🗑️ Quote ${quoteId} deleted by customer ${id}`);
    res.json({ success: true, message: `Quote ${quoteId} deleted successfully.` });
  } catch (err) {
    console.error("❌ Error deleting quote:", err);
    res.status(500).json({ success: false, error: "Failed to delete quote." });
  }
});

/* ============================================================
   ADMIN ROUTES
   ============================================================ */

// 🔍 Get One (Admin)
quotesAdminRouter.get("/:quoteId", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT q.*,
             c.name AS customer_name, c.business AS customer_business,
             c.email AS customer_email, c.phone AS customer_phone,
             c.address1, c.address2, c.city, c.county, c.postcode,
             o.id AS order_id,
             p.name AS package_name, p.price_oneoff AS package_price, p.price_monthly AS package_monthly,
             m.name AS maintenance_name, m.price AS maintenance_monthly
      FROM quotes q
      JOIN customers c ON q.customer_id = c.id
      LEFT JOIN orders o ON o.quote_id = q.id
      LEFT JOIN packages p ON q.package_id = p.id
      LEFT JOIN maintenance_plans m ON q.maintenance_id = m.id
      WHERE q.id = $1;
      `,
      [req.params.quoteId]
    );

    if (!rows.length)
      return res.status(404).json({ success: false, message: "Quote not found." });

    const quote = rows[0];
    quote.items = toArray(quote.items);
    res.json({ success: true, quote });
  } catch (err) {
    console.error("❌ Error fetching admin quote:", err);
    res.status(500).json({ success: false, message: "Failed to fetch quote." });
  }
});

// 🧩 Create Order from Quote (Monthly builds + maintenance aware)
quotesAdminRouter.post("/:quoteId/create-order", async (req, res) => {
  const { quoteId } = req.params;
  try {
    const q = await findQuote(quoteId);
    if (!q)
      return res.status(404).json({ success: false, message: "Quote not found." });

    const existing = await pool.query("SELECT id FROM orders WHERE quote_id=$1", [quoteId]);
    if (existing.rows.length)
      return res.json({ success: true, order: existing.rows[0], message: "Order already exists." });

    // 🔍 Load live package + maintenance data
    const pkg = q.package_id
      ? (await pool.query(`SELECT name, price_monthly FROM packages WHERE id=$1`, [q.package_id])).rows[0]
      : null;

    const maint = q.maintenance_id
      ? (await pool.query(`SELECT name, price FROM maintenance_plans WHERE id=$1`, [q.maintenance_id])).rows[0]
      : null;

    // 💰 Totals
    const total = calcSubtotal(q.items);
    const deposit = Number(q.deposit ?? total * 0.5);
    const balance = Math.max(0, total - deposit);

    // 🧾 Determine pricing mode
    const isMonthlyBuild = !!pkg?.price_monthly;
    const pricingMode = isMonthlyBuild ? "monthly" : "oneoff";

    // 🏗️ Monthly build + maintenance recurring setup
    const monthlyAmount = isMonthlyBuild ? Number(pkg.price_monthly || 0) : 0;
    const maintenanceMonthly = Number(maint?.price || 0);
    const maintenanceName = maint?.name || null;

    // 🏁 Insert order with full linkage
    const { rows } = await pool.query(
      `
      INSERT INTO orders (
        customer_id, quote_id, title, description, status, items, tasks,
        deposit, balance, diary,
        package_id, maintenance_id, pricing_mode,
        monthly_amount, maintenance_name, maintenance_monthly,
        created_at, updated_at
      )
      VALUES (
        $1,$2,$3,$4,'in_progress',$5,'[]',$6,$7,'[]',
        $8,$9,$10,$11,$12,$13,NOW(),NOW()
      )
      RETURNING *;
      `,
      [
        q.customer_id,
        quoteId,
        q.title,
        q.description || "",
        JSON.stringify(toArray(q.items)),
        deposit,
        balance,
        q.package_id || null,
        q.maintenance_id || null,
        pricingMode,
        monthlyAmount,
        maintenanceName,
        maintenanceMonthly,
      ]
    );

    const order = rows[0];
    console.log(`✅ Order #${order.id} created from quote #${quoteId} (${pricingMode})`);
    res.json({ success: true, order });
  } catch (err) {
    console.error("❌ Error creating order from quote:", err);
    res.status(500).json({ success: false, message: "Failed to create order from quote." });
  }
});


// ❌ Delete Quote (Admin)
quotesAdminRouter.delete("/:quoteId", async (req, res) => {
  const { quoteId } = req.params;
  try {
    const { rowCount } = await pool.query("DELETE FROM quotes WHERE id=$1;", [quoteId]);
    if (rowCount === 0)
      return res
        .status(404)
        .json({ success: false, message: "Quote not found or already deleted." });

    console.log(`🗑️ Admin deleted quote ${quoteId}`);
    res.json({ success: true, message: `Quote ${quoteId} deleted successfully.` });
  } catch (err) {
    console.error("❌ Error deleting admin quote:", err);
    res.status(500).json({ success: false, error: "Failed to delete quote." });
  }
});
