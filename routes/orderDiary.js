/**
 * ============================================================
 * PJH Web Services — Order Diary Routes
 * ============================================================
 * Each order can have multiple diary entries (progress, updates, etc.)
 * ============================================================
 */

import express from "express";
import pool from "../db.js";
const router = express.Router();

/* ============================================================
   📒 GET /api/diary/:orderId — Get diary entries for order
============================================================ */
router.get("/:orderId", async (req, res) => {
  const { orderId } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM order_diary WHERE order_id=$1 ORDER BY created_at DESC`,
      [orderId]
    );
    res.json({ success: true, entries: rows });
  } catch (err) {
    console.error("❌ Failed to load diary:", err);
    res.status(500).json({ success: false, error: "Failed to load diary entries" });
  }
});

/* ============================================================
   ✏️ POST /api/diary/:orderId — Add new diary entry
============================================================ */
router.post("/:orderId", async (req, res) => {
  const { orderId } = req.params;
  const { note, author = "Admin" } = req.body;
  if (!note?.trim()) return res.status(400).json({ success: false, error: "Empty note" });

  try {
    const { rows } = await pool.query(
      `INSERT INTO order_diary (order_id, note, author, created_at)
       VALUES ($1,$2,$3,NOW())
       RETURNING *`,
      [orderId, note.trim(), author]
    );
    res.json({ success: true, entry: rows[0] });
  } catch (err) {
    console.error("❌ Failed to add diary entry:", err);
    res.status(500).json({ success: false, error: "Failed to add diary entry" });
  }
});

/* ============================================================
   🗑️ DELETE /api/diary/:id — Delete a diary entry
============================================================ */
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query(`DELETE FROM order_diary WHERE id=$1`, [id]);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Failed to delete diary entry:", err);
    res.status(500).json({ success: false, error: "Failed to delete diary entry" });
  }
});

export default router;
