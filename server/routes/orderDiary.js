/**
 * ============================================================
 * PJH Web Services — Order Diary Routes
 * ============================================================
 * Handles per-order diary entries (notes, updates, progress logs)
 * Each diary entry links to an order via order_id.
 * ============================================================
 */

import express from "express";
import pool from "../db.js";

const router = express.Router();

/* -----------------------------
   GET /api/orders/:id/diary
   → Fetch all diary entries for an order
-------------------------------- */
router.get("/:id/diary", async (req, res) => {
  const { id } = req.params;

  try {
    const { rows } = await pool.query(
      `SELECT * FROM order_diary 
       WHERE order_id=$1 
       ORDER BY date DESC`,
      [id]
    );

    res.json({ success: true, diary: rows });
  } catch (err) {
    console.error("❌ Error fetching order diary:", err);
    res.status(500).json({ success: false, message: "Failed to fetch order diary." });
  }
});

/* -----------------------------
   POST /api/orders/:id/diary
   → Add a new diary entry
-------------------------------- */
router.post("/:id/diary", async (req, res) => {
  const { id } = req.params;
  const { note } = req.body;

  if (!note || note.trim() === "") {
    return res.status(400).json({ success: false, message: "Diary note cannot be empty." });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO order_diary (order_id, note, date)
       VALUES ($1, $2, NOW())
       RETURNING *`,
      [id, note.trim()]
    );

    res.status(201).json({ success: true, entry: rows[0] });
  } catch (err) {
    console.error("❌ Error adding diary entry:", err);
    res.status(500).json({ success: false, message: "Failed to add diary entry." });
  }
});

/* -----------------------------
   DELETE /api/orders/:id/diary/:entryId
   → Delete a diary entry
-------------------------------- */
router.delete("/:id/diary/:entryId", async (req, res) => {
  const { id, entryId } = req.params;

  try {
    const { rows } = await pool.query(
      `DELETE FROM order_diary 
       WHERE id=$1 AND order_id=$2 
       RETURNING id`,
      [entryId, id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Diary entry not found." });
    }

    res.json({ success: true, message: "Diary entry deleted." });
  } catch (err) {
    console.error("❌ Error deleting diary entry:", err);
    res.status(500).json({ success: false, message: "Failed to delete diary entry." });
  }
});

export default router;
