/**
 * ============================================================
 * PJH Web Services — Quote Utilities
 * ============================================================
 * Centralises shared helpers used by both customer and admin
 * quote routes. Handles item parsing, subtotal maths, and
 * safe quote lookups.
 * ============================================================
 */

import pool from "../db.js";

/* ------------------------------------------------------------
   🧩 toArray()
   Safely converts a string or null into an array.
------------------------------------------------------------ */
export function toArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/* ------------------------------------------------------------
   💰 calcSubtotal()
   Calculates total value of quote items (qty × unit price)
------------------------------------------------------------ */
export function calcSubtotal(items) {
  return toArray(items).reduce((sum, item) => {
    const qty = Number(item?.qty ?? 1) || 1;
    const unit = Number(item?.unit_price ?? item?.price ?? 0) || 0;
    return sum + qty * unit;
  }, 0);
}

/* ------------------------------------------------------------
   🔍 findQuote()
   Fetches a quote by ID and returns its row or null.
   Throws only for database-level errors.
------------------------------------------------------------ */
export async function findQuote(quoteId) {
  const { rows } = await pool.query("SELECT * FROM quotes WHERE id = $1", [quoteId]);
  return rows[0] || null;
}
