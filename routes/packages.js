/**
 * ============================================================
 * PJH Web Services — Packages Management API
 * ============================================================
 * Handles CRUD operations for website & CRM packages.
 * Powers both the public “Pricing” page and admin dashboard.
 * ============================================================
 */

import express from "express";
import pool from "../db.js";

const router = express.Router();

/* -----------------------------
   GET /api/packages
   Public view — fetch only visible packages
-------------------------------- */
router.get("/", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM packages WHERE visible = TRUE ORDER BY id ASC`
    );

    console.log(`📦 [API] Fetched ${rows.length} visible packages`);

    res.json({
      success: true,
      data: rows,
      count: rows.length,
    });
  } catch (err) {
    console.error("❌ [DB] Error fetching packages:", err.message);
    res.status(500).json({
      success: false,
      error: "Failed to fetch packages.",
    });
  }
});

/* -----------------------------
   GET /api/packages/all
   Admin view — fetch all (including hidden)
-------------------------------- */
router.get("/all", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM packages ORDER BY id ASC"
    );

    console.log(`📦 [Admin] Retrieved ${rows.length} total packages`);
    res.json({
      success: true,
      data: rows,
      count: rows.length,
    });
  } catch (err) {
    console.error("❌ [DB] Error fetching all packages:", err.message);
    res.status(500).json({
      success: false,
      error: "Failed to fetch all packages.",
    });
  }
});

/* -----------------------------
   POST /api/packages
   Create a new package (admin)
-------------------------------- */
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
  } = req.body;

  if (!name || !price_oneoff) {
    return res.status(400).json({
      success: false,
      error: "Package name and one-off price are required.",
    });
  }

  try {
    const { rows } = await pool.query(
      `
      INSERT INTO packages (
        name, tagline, price_oneoff, price_monthly, term_months,
        features, discount_percent, visible, created_at, updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
      RETURNING *;
      `,
      [
        name.trim(),
        tagline?.trim() || null,
        price_oneoff,
        price_monthly || null,
        term_months || 24,
        Array.isArray(features) ? features : [],
        discount_percent || 0,
        visible !== false, // default TRUE
      ]
    );

    const pkg = rows[0];
    console.log(`✅ [DB] Package created: ${pkg.name} (£${pkg.price_oneoff})`);

    res.status(201).json({
      success: true,
      message: "Package created successfully.",
      data: pkg,
    });
  } catch (err) {
    console.error("❌ [DB] Error creating package:", err.message);
    res.status(500).json({
      success: false,
      error: "Failed to create package.",
    });
  }
});

/* -----------------------------
   PUT /api/packages/:id
   Update an existing package
-------------------------------- */
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
  } = req.body;

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
        updated_at = NOW()
      WHERE id = $9
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
        visible,
        id,
      ]
    );

    if (!rows.length) {
      return res
        .status(404)
        .json({ success: false, error: "Package not found." });
    }

    console.log(`📝 [DB] Package updated: ${rows[0].name} (ID: ${id})`);

    res.json({
      success: true,
      message: "Package updated successfully.",
      data: rows[0],
    });
  } catch (err) {
    console.error("❌ [DB] Error updating package:", err.message);
    res.status(500).json({
      success: false,
      error: "Failed to update package.",
    });
  }
});

/* -----------------------------
   DELETE /api/packages/:id
   Delete a package
-------------------------------- */
router.delete("/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const { rows } = await pool.query(
      "DELETE FROM packages WHERE id = $1 RETURNING id, name",
      [id]
    );

    if (!rows.length) {
      return res
        .status(404)
        .json({ success: false, error: "Package not found." });
    }

    console.log(`🗑️ [DB] Package deleted: ${rows[0].name} (ID: ${id})`);
    res.json({
      success: true,
      message: "Package deleted successfully.",
      data: rows[0],
    });
  } catch (err) {
    console.error("❌ [DB] Error deleting package:", err.message);
    res.status(500).json({
      success: false,
      error: "Failed to delete package.",
    });
  }
});

export default router;
