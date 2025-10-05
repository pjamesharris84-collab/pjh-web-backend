/**
 * ============================================================
 * PJH Web Services — Quote Responses API
 * ============================================================
 * Enables clients to view and respond to quotes using
 * secure tokenised links (accept / reject / amend).
 * ============================================================
 */

import express from "express";
import pool from "../db.js";

const router = express.Router();

/* -----------------------------
   GET /api/quotes/by-token/:token
   Fetch quote by unique token
-------------------------------- */
router.get("/by-token/:token", async (req, res) => {
  const { token } = req.params;

  try {
    const { rows } = await pool.query(
      "SELECT * FROM quotes WHERE response_token=$1",
      [token]
    );

    if (rows.length === 0)
      return res.status(404).json({ success: false, message: "Quote not found." });

    const quote = rows[0];
    quote.items =
      typeof quote.items === "string" ? JSON.parse(quote.items) : quote.items || [];

    res.json({ success: true, quote });
  } catch (err) {
    console.error("❌ Error fetching quote by token:", err);
    res.status(500).json({ success: false, message: "Failed to fetch quote." });
  }
});

/* -----------------------------
   POST /api/quotes/by-token/:token/accept
   Accept quote
-------------------------------- */
router.post("/by-token/:token/accept", async (req, res) => {
  const { token } = req.params;

  try {
    const { rows } = await pool.query(
      `
      UPDATE quotes
      SET status='accepted', updated_at=NOW()
      WHERE response_token=$1
      RETURNING *;
      `,
      [token]
    );

    if (rows.length === 0)
      return res.status(404).json({ success: false, message: "Quote not found." });

    const quote = rows[0];

    await pool.query(
      `
      INSERT INTO quote_history (quote_id, action, actor, created_at)
      VALUES ($1, 'accepted', 'client', NOW());
      `,
      [quote.id]
    );

    res.json({ success: true, message: "Quote accepted.", quote });
  } catch (err) {
    console.error("❌ Error accepting quote:", err);
    res.status(500).json({ success: false, message: "Failed to accept quote." });
  }
});

/* -----------------------------
   POST /api/quotes/by-token/:token/reject
   Reject quote (with optional feedback)
-------------------------------- */
router.post("/by-token/:token/reject", async (req, res) => {
  const { token } = req.params;
  const { feedback } = req.body || {};

  try {
    const { rows } = await pool.query(
      `
      UPDATE quotes
      SET status='rejected', feedback=$2, updated_at=NOW()
      WHERE response_token=$1
      RETURNING *;
      `,
      [token, feedback || null]
    );

    if (rows.length === 0)
      return res.status(404).json({ success: false, message: "Quote not found." });

    const quote = rows[0];

    await pool.query(
      `
      INSERT INTO quote_history (quote_id, action, feedback, actor, created_at)
      VALUES ($1, 'rejected', $2, 'client', NOW());
      `,
      [quote.id, feedback || null]
    );

    res.json({ success: true, message: "Quote rejected.", quote });
  } catch (err) {
    console.error("❌ Error rejecting quote:", err);
    res.status(500).json({ success: false, message: "Failed to reject quote." });
  }
});

/* -----------------------------
   POST /api/quotes/by-token/:token/amend
   Request an amendment
-------------------------------- */
router.post("/by-token/:token/amend", async (req, res) => {
  const { token } = req.params;
  const { feedback } = req.body || {};

  try {
    const { rows } = await pool.query(
      `
      UPDATE quotes
      SET status='amend_requested', feedback=$2, updated_at=NOW()
      WHERE response_token=$1
      RETURNING *;
      `,
      [token, feedback || null]
    );

    if (rows.length === 0)
      return res.status(404).json({ success: false, message: "Quote not found." });

    const quote = rows[0];

    await pool.query(
      `
      INSERT INTO quote_history (quote_id, action, feedback, actor, created_at)
      VALUES ($1, 'amend_requested', $2, 'client', NOW());
      `,
      [quote.id, feedback || null]
    );

    res.json({ success: true, message: "Amendment requested.", quote });
  } catch (err) {
    console.error("❌ Error requesting amendment:", err);
    res.status(500).json({ success: false, message: "Failed to request amendment." });
  }
});

export default router;
