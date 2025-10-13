/**
 * ============================================================
 * PJH Web Services — Packages Management API (2025-10 Refined)
 * ============================================================
 * RESTful CRUD API for all PJH Web Services packages.
 * Aligned with current pricing & structure:
 *  • Starter   — £795 / £49×24
 *  • Business  — £1,495 / £85×24
 *  • Premium   — £2,950 / £160×24
 *
 * Adds unified pricing_guardrails to protect monthly plans:
 *   {
 *     require_deposit_months: 1,          // first month deposit
 *     min_term_months: 24,                // standard contract length
 *     early_exit_fee_pct: 35,             // fair early termination fee
 *     ownership_until_paid: true,         // PJH retains site IP until full payment
 *     late_fee_pct: 5,                    // interest on overdue invoices
 *     default_payment_method: "direct_debit",
 *     tcs_version: "2025-10"
 *   }
 *
 * Includes:
 *   • GET /api/packages                → public visible list
 *   • GET /api/packages/:id            → single by numeric ID
 *   • GET /api/packages/slug/:slug     → lookup by name
 *   • GET /api/packages/all            → admin full list
 *   • POST /api/packages               → create (admin)
 *   • PUT /api/packages/:id            → update (admin)
 *   • DELETE /api/packages/:id         → delete (admin)
 * ============================================================
 */

import express from "express";
import pool from "../db.js";

const router = express.Router();

/* ------------------------------------------------------------
   🧩 Helpers
------------------------------------------------------------ */
function toGuardrails(input) {
  let g = {};
  if (!input)
    return {
      require_deposit_months: 1,
      min_term_months: 24,
      early_exit_fee_pct: 35,
      ownership_until_paid: true,
      late_fee_pct: 5,
      default_payment_method: "direct_debit",
      tcs_version: "2025-10",
    };

  if (typeof input === "string") {
    try {
      g = JSON.parse(input);
    } catch {
      g = {};
    }
  } else if (typeof input === "object") {
    g = { ...input };
  }

  return {
    require_deposit_months: Math.max(0, Number(g.require_deposit_months ?? 1)),
    min_term_months: Math.max(1, Number(g.min_term_months ?? 24)),
    early_exit_fee_pct: Math.max(0, Number(g.early_exit_fee_pct ?? 35)),
    ownership_until_paid: g.ownership_until_paid !== false,
    late_fee_pct: Math.max(0, Number(g.late_fee_pct ?? 5)),
    default_payment_method: String(g.default_payment_method || "direct_debit"),
    tcs_version: String(g.tcs_version || "2025-10"),
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

/* ------------------------------------------------------------
   🌍 PUBLIC ROUTES
------------------------------------------------------------ */

// GET /api/packages — visible only
router.get("/", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, name, tagline, price_oneoff, price_monthly, term_months,
             features, description, visible,
             COALESCE(pricing_guardrails, '{}'::jsonb) AS pricing_guardrails
      FROM packages
      WHERE visible = TRUE
      ORDER BY id ASC;
    `);

    res.json({ success: true, data: rows, count: rows.length });
  } catch (err) {
    console.error("❌ [DB] Error fetching packages:", err.message);
    res.status(500).json({ success: false, error: "Failed to fetch packages." });
  }
});

// GET /api/packages/slug/:slug — public SEO-friendly
router.get("/slug/:slug", async (req, res) => {
  try {
    const { slug } = req.params;
    const { rows } = await pool.query(
      `
      SELECT *
      FROM packages
      WHERE LOWER(name) = LOWER($1)
      AND visible = TRUE
      LIMIT 1;
      `,
      [slug]
    );

    if (!rows.length)
      return res.status(404).json({ success: false, error: "Package not found." });

    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error("❌ [DB] Error fetching package by slug:", err.message);
    res.status(500).json({ success: false, error: "Failed to fetch package by slug." });
  }
});

// GET /api/packages/:id — public by numeric ID
router.get("/:id", async (req, res) => {
  const { id } = req.params;

  if (isNaN(Number(id))) {
    return res.status(400).json({ success: false, error: "Invalid package ID." });
  }

  try {
    const { rows } = await pool.query(
      `SELECT * FROM packages WHERE id = $1 AND visible = TRUE LIMIT 1;`,
      [id]
    );

    if (!rows.length)
      return res.status(404).json({ success: false, error: "Package not found." });

    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error("❌ [DB] Error fetching package by ID:", err.message);
    res.status(500).json({ success: false, error: "Failed to fetch package by ID." });
  }
});

/* ------------------------------------------------------------
   🔐 ADMIN ROUTES
------------------------------------------------------------ */

// GET /api/packages/all — admin full list
router.get("/all", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, name, tagline, price_oneoff, price_monthly, term_months,
             features, description, discount_percent, visible,
             COALESCE(pricing_guardrails, '{}'::jsonb) AS pricing_guardrails
      FROM packages
      ORDER BY id ASC;
    `);
    res.json({ success: true, data: rows, count: rows.length });
  } catch (err) {
    console.error("❌ [DB] Error fetching all packages:", err.message);
    res.status(500).json({ success: false, error: "Failed to fetch all packages." });
  }
});

// POST /api/packages — admin create
router.post("/", async (req, res) => {
  const {
    name,
    tagline,
    price_oneoff,
    price_monthly,
    term_months,
    features,
    description,
    discount_percent,
    visible,
    pricing_guardrails,
  } = req.body;

  if (!name)
    return res.status(400).json({ success: false, error: "Package name is required." });

  const guards = toGuardrails(pricing_guardrails);

  if (price_monthly && Number(price_monthly) > 0 && (!term_months || Number(term_months) < 1)) {
    return res.status(400).json({
      success: false,
      error: "Monthly plans require a valid term_months (e.g. 24).",
    });
  }

  try {
    const { rows } = await pool.query(
      `
      INSERT INTO packages (
        name, tagline, price_oneoff, price_monthly, term_months,
        features, description, discount_percent, visible, pricing_guardrails,
        created_at, updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,NOW(),NOW())
      RETURNING *;
      `,
      [
        name.trim(),
        tagline?.trim() || null,
        price_oneoff ?? null,
        price_monthly ?? null,
        term_months || null,
        ensureArray(features),
        description?.trim() || null,
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

// PUT /api/packages/:id — admin update
router.put("/:id", async (req, res) => {
  const { id } = req.params;
  const {
    name,
    tagline,
    price_oneoff,
    price_monthly,
    term_months,
    features,
    description,
    discount_percent,
    visible,
    pricing_guardrails,
  } = req.body;

  const guards = pricing_guardrails ? toGuardrails(pricing_guardrails) : null;

  if (price_monthly && Number(price_monthly) > 0 && (!term_months || Number(term_months) < 1)) {
    return res.status(400).json({
      success: false,
      error: "Monthly plans require a valid term_months (e.g. 24).",
    });
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
        description = COALESCE($7, description),
        discount_percent = COALESCE($8, discount_percent),
        visible = COALESCE($9, visible),
        pricing_guardrails = COALESCE($10::jsonb, pricing_guardrails),
        updated_at = NOW()
      WHERE id = $11
      RETURNING *;
      `,
      [
        name?.trim() || null,
        tagline?.trim() || null,
        price_oneoff,
        price_monthly,
        term_months,
        Array.isArray(features) ? features : null,
        description?.trim() || null,
        discount_percent,
        typeof visible === "boolean" ? visible : null,
        guards ? JSON.stringify(guards) : null,
        id,
      ]
    );

    if (!rows.length)
      return res.status(404).json({ success: false, error: "Package not found." });

    res.json({
      success: true,
      message: "Package updated successfully.",
      data: rows[0],
    });
  } catch (err) {
    console.error("❌ [DB] Error updating package:", err.message);
    res.status(500).json({ success: false, error: "Failed to update package." });
  }
});

// DELETE /api/packages/:id — admin delete
router.delete("/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const { rows } = await pool.query(
      `DELETE FROM packages WHERE id = $1 RETURNING id, name;`,
      [id]
    );

    if (!rows.length)
      return res.status(404).json({ success: false, error: "Package not found." });

    res.json({
      success: true,
      message: "Package deleted successfully.",
      data: rows[0],
    });
  } catch (err) {
    console.error("❌ [DB] Error deleting package:", err.message);
    res.status(500).json({ success: false, error: "Failed to delete package." });
  }
});

export default router;
