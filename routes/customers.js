/**
 * ============================================================
 * PJH Web Services — Customer Management API (2025 Refined)
 * ============================================================
 * Central CRM API for PJH Web Services:
 *   • Full CRUD for customer profiles
 *   • Joins with quotes and orders for admin panels
 *   • Cascade-safe deletions (removes related quotes + orders)
 *   • Consistent JSON schema across all endpoints
 * ============================================================
 */

import express from "express";
import pool from "../db.js";

const router = express.Router();

/* ============================================================
   🧱 GET /api/customers
   Fetch all customers
============================================================ */
router.get("/", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT *
      FROM customers
      ORDER BY created_at DESC;
    `);

    res.json({
      success: true,
      message: "Customers retrieved successfully.",
      data: rows,
      count: rows.length,
    });
  } catch (err) {
    console.error("❌ [DB][Customers] Error fetching customers:", err);
    res.status(500).json({
      success: false,
      error: "Failed to fetch customers.",
    });
  }
});

/* ============================================================
   ➕ POST /api/customers
   Create a new customer
============================================================ */
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
      VALUES 
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW())
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

    if (!rows.length) throw new Error("Customer insert returned no data.");

    const customer = rows[0];
    console.log(`✅ [DB][Customers] Created: ${customer.name} (ID: ${customer.id})`);
    res.status(201).json({
      success: true,
      message: "Customer created successfully.",
      data: customer,
    });
  } catch (err) {
    console.error("❌ [DB][Customers] Error creating customer:", err);
    res.status(500).json({
      success: false,
      error: "Failed to create customer.",
    });
  }
});

/* ============================================================
   🔍 GET /api/customers/:id
   Fetch single customer by ID
============================================================ */
router.get("/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const { rows } = await pool.query("SELECT * FROM customers WHERE id = $1;", [id]);

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        error: "Customer not found.",
      });
    }

    res.json({
      success: true,
      message: "Customer retrieved successfully.",
      data: rows[0],
    });
  } catch (err) {
    console.error("❌ [DB][Customers] Error fetching customer:", err);
    res.status(500).json({
      success: false,
      error: "Failed to fetch customer.",
    });
  }
});

/* ============================================================
   ✏️ PUT /api/customers/:id
   Update existing customer
============================================================ */
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
      return res.status(404).json({
        success: false,
        error: "Customer not found.",
      });
    }

    console.log(`📝 [DB][Customers] Updated (ID: ${id})`);
    res.json({
      success: true,
      message: "Customer updated successfully.",
      data: rows[0],
    });
  } catch (err) {
    console.error("❌ [DB][Customers] Error updating customer:", err);
    res.status(500).json({
      success: false,
      error: "Failed to update customer.",
    });
  }
});

/* ============================================================
   🗑️ DELETE /api/customers/:id
   Delete customer and cascade related data
============================================================ */
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Remove related quotes & orders first
    await client.query("DELETE FROM orders WHERE customer_id = $1;", [id]);
    await client.query("DELETE FROM quotes WHERE customer_id = $1;", [id]);

    const { rowCount } = await client.query("DELETE FROM customers WHERE id = $1;", [id]);

    await client.query("COMMIT");

    if (rowCount === 0) {
      return res.status(404).json({
        success: false,
        error: "Customer not found or already deleted.",
      });
    }

    console.log(`🗑️ [DB][Customers] Deleted (ID: ${id}) + related records`);
    res.json({
      success: true,
      message: "Customer and related records deleted successfully.",
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ [DB][Customers] Error deleting customer:", err);
    res.status(500).json({
      success: false,
      error: "Failed to delete customer and related records.",
    });
  } finally {
    client.release();
  }
});

/* ============================================================
   🧾 GET /api/customers/:id/quotes
   Fetch all quotes for a customer
============================================================ */
router.get("/:id/quotes", async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `
      SELECT q.*, 
             p.name AS package_name,
             p.price_oneoff,
             p.price_monthly,
             m.name AS maintenance_name,
             m.price AS maintenance_monthly
      FROM quotes q
      LEFT JOIN packages p ON q.package_id = p.id
      LEFT JOIN maintenance_plans m ON q.maintenance_id = m.id
      WHERE q.customer_id = $1
      ORDER BY q.created_at DESC;
      `,
      [id]
    );

    res.json({
      success: true,
      message: "Quotes retrieved successfully.",
      data: rows,
    });
  } catch (err) {
    console.error("❌ [DB][Customers] Error fetching customer quotes:", err);
    res.status(500).json({
      success: false,
      error: "Failed to fetch customer quotes.",
    });
  }
});

/* ============================================================
   📦 GET /api/customers/:id/orders
   Fetch all orders for a customer
============================================================ */
router.get("/:id/orders", async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `
      SELECT o.*, 
             c.name AS customer_name,
             c.business AS customer_business,
             o.maintenance_name,
             o.maintenance_monthly
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      WHERE o.customer_id = $1
      ORDER BY o.created_at DESC;
      `,
      [id]
    );

    res.json({
      success: true,
      message: "Orders retrieved successfully.",
      data: rows,
    });
  } catch (err) {
    console.error("❌ [DB][Customers] Error fetching customer orders:", err);
    res.status(500).json({
      success: false,
      error: "Failed to fetch customer orders.",
    });
  }
});

export default router;
