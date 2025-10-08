/**
 * ============================================================
 * PJH Web Services — Packages Management API
 * ============================================================
 * CRUD for website & CRM packages.
 * Adds flexible `pricing_guardrails` for pay-monthly controls:
 *   {
 *     require_deposit_months: 1,
 *     min_term_months: 24,
 *     early_exit_fee_pct: 40,
 *     ownership_until_paid: true,
 *     late_fee_pct: 5,
 *     default_payment_method: "direct_debit",
 *     tcs_version: "2025-01"
 *   }
 * ============================================================
 */

import express from "express";
import pool from "../db.js";

const router = express.Router();

// --------- helpers ----------
function toGuardrails(input) {
  // Accept object or JSON string; coerce with sensible defaults
  let g = {};
  if (!input) return {
    require_deposit_months: 1,
    min_term_months: 24,
    early_exit_fee_pct: 40,
    ownership_until_paid: true,
    late_fee_pct: 5,
    default_payment_method: "direct_debit",
    tcs_version: "2025-01",
  };
  if (typeof input === "string") {
    try { g = JSON.parse(input); } catch { g = {}; }
  } else if (typeof input === "object") {
    g = { ...input };
  }
  return {
    require_deposit_months: Math.max(0, Number(g.require_deposit_months ?? 1)),
    min_term_months: Math.max(1, Number(g.min_term_months ?? 24)),
    early_exit_fee_pct: Math.max(0, Number(g.early_exit_fee_pct ?? 40)),
    ownership_until_paid: g.ownership_until_paid !== false,
    late_fee_pct: Math.max(0, Number(g.late_fee_pct ?? 5)),
    default_payment_method: String(g.default_payment_method || "direct_debit"),
    tcs_version: String(g.tcs_version || "2025-01"),
  };
}

function ensureArray(val) {
  if (Array.isArray(val)) return val;
  if (typeof val === "string") {
    return val
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

// -----------------------------
// GET /api/packages (public, visible only)
// -----------------------------
router.get("/", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, name, tagline, price_oneoff, price_monthly, term_months, features, discount_percent, visible, 
             COALESCE(pricing_guardrails, '{}'::jsonb) AS pricing_guardrails
      FROM packages 
      WHERE visible = TRUE 
      ORDER BY id ASC
    `);

    res.json({ success: true, data: rows, count: rows.length });
  } catch (err) {
    console.error("❌ [DB] Error fetching packages:", err.message);
    res.status(500).json({ success: false, error: "Failed to fetch packages." });
  }
});

// -----------------------------
// GET /api/packages/all (admin)
// -----------------------------
router.get("/all", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, name, tagline, price_oneoff, price_monthly, term_months, features, discount_percent, visible, 
             COALESCE(pricing_guardrails, '{}'::jsonb) AS pricing_guardrails
      FROM packages 
      ORDER BY id ASC
    `);
    res.json({ success: true, data: rows, count: rows.length });
  } catch (err) {
    console.error("❌ [DB] Error fetching all packages:", err.message);
    res.status(500).json({ success: false, error: "Failed to fetch all packages." });
  }
});

// -----------------------------
// POST /api/packages (admin)
// -----------------------------
router.post("/", async (req, res) => {
  const {
    name,
    tagline,
    price_oneoff,
    price_monthly,
    term_months,
    features,
    discount_percent,
    visible,
    pricing_guardrails,
  } = req.body;

  if (!name) {
    return res.status(400).json({ success: false, error: "Package name is required." });
  }

  // ⚖️ validation for monthly plans
  const guards = toGuardrails(pricing_guardrails);
  if (price_monthly && Number(price_monthly) > 0) {
    if (!term_months || Number(term_months) < 1) {
      return res.status(400).json({ success: false, error: "Monthly plans require a valid term_months (e.g., 24)." });
    }
  }

  try {
    const { rows } = await pool.query(
      `
      INSERT INTO packages (
        name, tagline, price_oneoff, price_monthly, term_months,
        features, discount_percent, visible, pricing_guardrails, created_at, updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,NOW(),NOW())
      RETURNING *;
      `,
      [
        name.trim(),
        tagline?.trim() || null,
        price_oneoff ?? null,
        price_monthly ?? null,
        term_months || null,
        ensureArray(features),
        discount_percent || 0,
        visible !== false,
        JSON.stringify(guards),
      ]
    );

    res.status(201).json({
      success: true,
      message: "Package created successfully.",
      data: rows[0],
    });
  } catch (err) {
    console.error("❌ [DB] Error creating package:", err.message);
    res.status(500).json({ success: false, error: "Failed to create package." });
  }
});

// -----------------------------
// PUT /api/packages/:id (admin)
// -----------------------------
router.put("/:id", async (req, res) => {
  const { id } = req.params;
  const {
    name,
    tagline,
    price_oneoff,
    price_monthly,
    term_months,
    features,
    discount_percent,
    visible,
    pricing_guardrails,
  } = req.body;

  const guards = pricing_guardrails ? toGuardrails(pricing_guardrails) : null;

  // If updating to a monthly plan, validate term
  if (price_monthly && Number(price_monthly) > 0) {
    if (!term_months || Number(term_months) < 1) {
      return res.status(400).json({ success: false, error: "Monthly plans require a valid term_months (e.g., 24)." });
    }
  }

  try {
    const { rows } = await pool.query(
      `
      UPDATE packages
      SET 
        name = COALESCE($1, name),
        tagline = COALESCE($2, tagline),
        price_oneoff = COALESCE($3, price_oneoff),
        price_monthly = COALESCE($4, price_monthly),
        term_months = COALESCE($5, term_months),
        features = COALESCE($6, features),
        discount_percent = COALESCE($7, discount_percent),
        visible = COALESCE($8, visible),
        pricing_guardrails = COALESCE($9::jsonb, pricing_guardrails),
        updated_at = NOW()
      WHERE id = $10
      RETURNING *;
      `,
      [
        name?.trim() || null,
        tagline?.trim() || null,
        price_oneoff,
        price_monthly,
        term_months,
        Array.isArray(features) ? features : null,
        discount_percent,
        typeof visible === "boolean" ? visible : null,
        guards ? JSON.stringify(guards) : null,
        id,
      ]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, error: "Package not found." });
    }

    res.json({ success: true, message: "Package updated successfully.", data: rows[0] });
  } catch (err) {
    console.error("❌ [DB] Error updating package:", err.message);
    res.status(500).json({ success: false, error: "Failed to update package." });
  }
});

// -----------------------------
// DELETE /api/packages/:id (admin)
// -----------------------------
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      "DELETE FROM packages WHERE id = $1 RETURNING id, name",
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, error: "Package not found." });
    }

    res.json({ success: true, message: "Package deleted successfully.", data: rows[0] });
  } catch (err) {
    console.error("❌ [DB] Error deleting package:", err.message);
    res.status(500).json({ success: false, error: "Failed to delete package." });
  }
});

export default router;
