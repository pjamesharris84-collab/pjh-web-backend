/**
 * ============================================================
 * PJH Web Services — Customer Management API
 * ============================================================
 * CRUD endpoints for managing customer records in PostgreSQL.
 * Powers the Admin CRM and Quote System.
 * ============================================================
 */

import express from "express";
import pool from "../db.js";

const router = express.Router();

/* -----------------------------
   GET /api/customers
   Fetch all customers
-------------------------------- */
router.get("/", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT * FROM customers ORDER BY id DESC
    `);
    res.json({ success: true, customers: rows });
  } catch (err) {
    console.error("❌ [DB] Error fetching customers:", err);
    res
      .status(500)
      .json({ success: false, error: "Failed to fetch customers." });
  }
});

/* -----------------------------
   POST /api/customers
   Create a new customer
-------------------------------- */
router.post("/", async (req, res) => {
  const {
    business,
    name,
    email,
    phone,
    address1,
    address2,
    city,
    county,
    postcode,
    notes,
  } = req.body;

  // 🧾 Validation
  if (!name || !email) {
    return res.status(400).json({
      success: false,
      error: "Name and email are required to create a customer.",
    });
  }

  try {
    const { rows } = await pool.query(
      `
      INSERT INTO customers 
      (business, name, email, phone, address1, address2, city, county, postcode, notes, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW())
      RETURNING *;
    `,
      [
        business?.trim() || null,
        name.trim(),
        email.trim().toLowerCase(),
        phone?.trim() || null,
        address1?.trim() || null,
        address2?.trim() || null,
        city?.trim() || null,
        county?.trim() || null,
        postcode?.trim() || null,
        notes?.trim() || null,
      ]
    );

    if (!rows.length) {
      throw new Error("Customer insert returned no data");
    }

    const customer = rows[0];
    console.log(`✅ [DB] Customer created: ${customer.name} (ID: ${customer.id})`);

    res.status(201).json({ success: true, customer });
  } catch (err) {
    console.error("❌ [DB] Error creating customer:", err);
    res
      .status(500)
      .json({ success: false, error: "Failed to create customer." });
  }
});

/* -----------------------------
   GET /api/customers/:id
   Fetch single customer by ID
-------------------------------- */
router.get("/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const { rows } = await pool.query(
      "SELECT * FROM customers WHERE id = $1",
      [id]
    );

    if (!rows.length) {
      return res
        .status(404)
        .json({ success: false, error: "Customer not found." });
    }

    res.json({ success: true, customer: rows[0] });
  } catch (err) {
    console.error("❌ [DB] Error fetching customer:", err);
    res
      .status(500)
      .json({ success: false, error: "Failed to fetch customer." });
  }
});

/* -----------------------------
   PUT /api/customers/:id
   Update existing customer
-------------------------------- */
router.put("/:id", async (req, res) => {
  const { id } = req.params;
  const {
    business,
    name,
    email,
    phone,
    address1,
    address2,
    city,
    county,
    postcode,
    notes,
  } = req.body;

  try {
    const { rows } = await pool.query(
      `
      UPDATE customers
      SET 
        business = $1,
        name = $2,
        email = $3,
        phone = $4,
        address1 = $5,
        address2 = $6,
        city = $7,
        county = $8,
        postcode = $9,
        notes = $10,
        updated_at = NOW()
      WHERE id = $11
      RETURNING *;
    `,
      [
        business?.trim() || null,
        name?.trim() || null,
        email?.trim()?.toLowerCase() || null,
        phone?.trim() || null,
        address1?.trim() || null,
        address2?.trim() || null,
        city?.trim() || null,
        county?.trim() || null,
        postcode?.trim() || null,
        notes?.trim() || null,
        id,
      ]
    );

    if (!rows.length) {
      return res
        .status(404)
        .json({ success: false, error: "Customer not found." });
    }

    console.log(`📝 [DB] Customer updated (ID: ${id})`);
    res.json({ success: true, customer: rows[0] });
  } catch (err) {
    console.error("❌ [DB] Error updating customer:", err);
    res
      .status(500)
      .json({ success: false, error: "Failed to update customer." });
  }
});

/* -----------------------------
   DELETE /api/customers/:id
   Delete a customer by ID
-------------------------------- */
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      "DELETE FROM customers WHERE id = $1 RETURNING id",
      [id]
    );

    if (!rows.length) {
      return res
        .status(404)
        .json({ success: false, error: "Customer not found." });
    }

    console.log(`🗑️ [DB] Customer deleted (ID: ${id})`);
    res.json({ success: true, message: "Customer deleted successfully." });
  } catch (err) {
    console.error("❌ [DB] Error deleting customer:", err);
    res
      .status(500)
      .json({ success: false, error: "Failed to delete customer." });
  }
});

export default router;
