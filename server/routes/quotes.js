/**
 * ============================================================
 * PJH Web Services — Quotes API (Customer + Admin Routers)
 * ============================================================
 * Customer routes (mounted at /api/customers):
 *   POST   /:id/quotes                -> create quote for customer
 *   GET    /:id/quotes                -> list quotes for customer
 *   GET    /:id/quotes/:quoteId       -> get single quote for customer
 *   PUT    /:id/quotes/:quoteId       -> update quote for customer
 *   DELETE /:id/quotes/:quoteId       -> delete quote for customer
 *
 * Admin routes (mounted at /api/quotes):
 *   GET    /:quoteId                  -> get single quote (with customer join + order_id)
 *   PUT    /:quoteId                  -> update quote (global)
 *   DELETE /:quoteId                  -> delete quote (global)
 *   POST   /:quoteId/email            -> generate branded PDF + email it
 *   POST   /:quoteId/accept           -> set status=accepted (+history)
 *   POST   /:quoteId/reject           -> set status=rejected (+history)
 *   POST   /:quoteId/create-order     -> create order from accepted quote
 *   GET    /:quoteId/order            -> fetch linked order (if any)
 * ============================================================
 */

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import pool, { generateQuoteNumber } from "../db.js";
import { generateResponseToken } from "../utils/token.js";
import { sendEmail } from "../utils/email.js";
import { generateQuotePDF } from "../utils/pdf.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const quotesCustomerRouter = express.Router();
export const quotesAdminRouter = express.Router();

/* ======================== Helpers ======================== */

function toArray(value) {
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

function calcSubtotal(items) {
  const arr = toArray(items);
  return arr.reduce((sum, it) => {
    const qty = Number(it?.qty ?? 1) || 1;
    const unit = Number(it?.unit_price ?? it?.price ?? 0) || 0;
    return sum + qty * unit;
  }, 0);
}

/* ==================== CUSTOMER ROUTES ==================== */

// Create
quotesCustomerRouter.post("/:id/quotes", async (req, res) => {
  const { id } = req.params;
  const { title, description, items, deposit, notes } = req.body;

  try {
    const { rows: cRows } = await pool.query("SELECT * FROM customers WHERE id=$1", [id]);
    if (cRows.length === 0) return res.status(404).json({ success: false, error: "Customer not found." });

    const customer = cRows[0];
    const quoteNumber = await generateQuoteNumber(id, customer.business || customer.name);
    const responseToken = generateResponseToken();

    const safeItems = toArray(items);

    const { rows } = await pool.query(
      `
      INSERT INTO quotes
        (customer_id, quote_number, title, description, items, deposit, notes, status, response_token, created_at, updated_at)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,'pending',$8,NOW(),NOW())
      RETURNING *;
      `,
      [
        id,
        quoteNumber,
        title || "",
        description || "",
        JSON.stringify(safeItems),
        deposit ?? null,
        notes || "",
        responseToken,
      ]
    );

    res.status(201).json({ success: true, quote: rows[0] });
  } catch (err) {
    console.error("❌ Error creating quote:", err);
    res.status(500).json({ success: false, error: "Failed to create quote." });
  }
});

// List
quotesCustomerRouter.get("/:id/quotes", async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      "SELECT * FROM quotes WHERE customer_id=$1 ORDER BY created_at DESC",
      [id]
    );

    const quotes = rows.map((q) => ({
      ...q,
      items: toArray(q.items),
    }));

    res.json({ success: true, quotes });
  } catch (err) {
    console.error("❌ Error fetching quotes:", err);
    res.status(500).json({ success: false, error: "Failed to fetch quotes." });
  }
});

// Get one (customer scope)
quotesCustomerRouter.get("/:id/quotes/:quoteId", async (req, res) => {
  const { id, quoteId } = req.params;
  try {
    const { rows } = await pool.query(
      "SELECT * FROM quotes WHERE id=$1 AND customer_id=$2",
      [quoteId, id]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, error: "Quote not found." });

    const quote = rows[0];
    quote.items = toArray(quote.items);
    res.json({ success: true, quote });
  } catch (err) {
    console.error("❌ Error fetching quote:", err);
    res.status(500).json({ success: false, error: "Failed to fetch quote." });
  }
});

// Update (customer scope)
quotesCustomerRouter.put("/:id/quotes/:quoteId", async (req, res) => {
  const { id, quoteId } = req.params;
  const { title, description, items, deposit, notes, status } = req.body; // status ignored on customer scope

  try {
    const { rows } = await pool.query(
      "SELECT id FROM quotes WHERE id=$1 AND customer_id=$2",
      [quoteId, id]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, error: "Quote not found." });

    await pool.query(
      `
      UPDATE quotes
      SET title=$1, description=$2, items=$3, deposit=$4, notes=$5, updated_at=NOW()
      WHERE id=$6 AND customer_id=$7
      `,
      [title || "", description || "", JSON.stringify(toArray(items)), deposit ?? null, notes || "", quoteId, id]
    );

    res.json({ success: true, message: "Quote updated successfully." });
  } catch (err) {
    console.error("❌ Error updating quote:", err);
    res.status(500).json({ success: false, error: "Failed to update quote." });
  }
});

// Delete (customer scope)
quotesCustomerRouter.delete("/:id/quotes/:quoteId", async (req, res) => {
  const { id, quoteId } = req.params;
  try {
    const result = await pool.query(
      "DELETE FROM quotes WHERE id=$1 AND customer_id=$2 RETURNING id",
      [quoteId, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: "Quote not found." });

    res.json({ success: true, message: "Quote deleted." });
  } catch (err) {
    console.error("❌ Error deleting quote:", err);
    res.status(500).json({ success: false, error: "Failed to delete quote." });
  }
});

/* ====================== ADMIN ROUTES ====================== */

// Get one (admin, with customer join and linked order_id if any)
quotesAdminRouter.get("/:quoteId", async (req, res) => {
  const { quoteId } = req.params;
  try {
    const { rows } = await pool.query(
      `
      SELECT q.*,
             c.name      AS customer_name,
             c.business  AS customer_business,
             c.email     AS customer_email,
             c.phone     AS customer_phone,
             c.address1, c.address2, c.city, c.county, c.postcode,
             o.id        AS order_id
      FROM quotes q
      JOIN customers c ON q.customer_id = c.id
      LEFT JOIN orders   o ON o.quote_id = q.id
      WHERE q.id = $1
      `,
      [quoteId]
    );

    if (rows.length === 0) return res.status(404).json({ success: false, message: "Quote not found." });

    const quote = rows[0];
    quote.items = toArray(quote.items);
    res.json({ success: true, quote });
  } catch (err) {
    console.error("❌ Error fetching global quote:", err);
    res.status(500).json({ success: false, message: "Failed to fetch quote." });
  }
});

// Update (admin)
quotesAdminRouter.put("/:quoteId", async (req, res) => {
  const { quoteId } = req.params;
  const { title, description, items, deposit, notes, status } = req.body;

  try {
    const { rows } = await pool.query("SELECT id FROM quotes WHERE id=$1", [quoteId]);
    if (rows.length === 0) return res.status(404).json({ success: false, error: "Quote not found." });

    await pool.query(
      `
      UPDATE quotes
      SET title=$1, description=$2, items=$3, deposit=$4, notes=$5, status=COALESCE($6,status), updated_at=NOW()
      WHERE id=$7
      `,
      [title || "", description || "", JSON.stringify(toArray(items)), deposit ?? null, notes || "", status ?? null, quoteId]
    );

    res.json({ success: true, message: "Quote updated successfully." });
  } catch (err) {
    console.error("❌ Error updating global quote:", err);
    res.status(500).json({ success: false, error: "Failed to update quote." });
  }
});

// Delete (admin)
quotesAdminRouter.delete("/:quoteId", async (req, res) => {
  const { quoteId } = req.params;
  try {
    const result = await pool.query("DELETE FROM quotes WHERE id=$1 RETURNING id", [quoteId]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: "Quote not found." });

    res.json({ success: true, message: "Quote deleted globally." });
  } catch (err) {
    console.error("❌ Error deleting global quote:", err);
    res.status(500).json({ success: false, error: "Failed to delete quote." });
  }
});

// Email (admin) — generate PDF + send
quotesAdminRouter.post("/:quoteId/email", async (req, res) => {
  const { quoteId } = req.params;
  try {
    const { rows } = await pool.query(
      `
      SELECT q.*,
             c.name      AS customer_name,
             c.business  AS customer_business,
             c.email     AS customer_email,
             c.address1, c.address2, c.city, c.county, c.postcode,
             c.phone     AS customer_phone
      FROM quotes q
      JOIN customers c ON q.customer_id = c.id
      WHERE q.id = $1
      `,
      [quoteId]
    );

    if (rows.length === 0) return res.status(404).json({ success: false, message: "Quote not found." });

    const quoteRow = rows[0];
    const pdfPath = await generateQuotePDF(quoteRow);

    const recipient = quoteRow.customer_email;
    const displayName = quoteRow.customer_business || quoteRow.customer_name || "Customer";
    const subject = `Quote #${quoteRow.quote_number} from PJH Web Services`;

    await sendEmail({
      to: recipient,
      subject,
      text: `Dear ${displayName},

Please find attached your quote from PJH Web Services.

Kind regards,
PJH Web Services`,
      attachments: [{ filename: path.basename(pdfPath), path: pdfPath }],
    });

    console.log(`📧 Quote #${quoteRow.quote_number} emailed to ${recipient}`);
    res.json({ success: true, message: "Quote emailed successfully." });
  } catch (err) {
    console.error("❌ Error emailing quote:", err);
    res.status(500).json({ success: false, error: "Failed to email quote." });
  }
});

/* -------- Status workflow & Order creation (admin) -------- */

// Accept quote
quotesAdminRouter.post("/:quoteId/accept", async (req, res) => {
  const { quoteId } = req.params;
  const feedback = req.body?.feedback || null;
  try {
    const { rows } = await pool.query("UPDATE quotes SET status='accepted', updated_at=NOW() WHERE id=$1 RETURNING *", [quoteId]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: "Quote not found." });

    await pool.query(
      `INSERT INTO quote_history (quote_id, action, feedback, actor) VALUES ($1,'accepted',$2,'admin')`,
      [quoteId, feedback]
    );

    res.json({ success: true, quote: rows[0], message: "Quote accepted." });
  } catch (err) {
    console.error("❌ Error accepting quote:", err);
    res.status(500).json({ success: false, error: "Failed to accept quote." });
  }
});

// Reject quote
quotesAdminRouter.post("/:quoteId/reject", async (req, res) => {
  const { quoteId } = req.params;
  const feedback = req.body?.feedback || null;
  try {
    const { rows } = await pool.query("UPDATE quotes SET status='rejected', updated_at=NOW() WHERE id=$1 RETURNING *", [quoteId]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: "Quote not found." });

    await pool.query(
      `INSERT INTO quote_history (quote_id, action, feedback, actor) VALUES ($1,'rejected',$2,'admin')`,
      [quoteId, feedback]
    );

    res.json({ success: true, quote: rows[0], message: "Quote rejected." });
  } catch (err) {
    console.error("❌ Error rejecting quote:", err);
    res.status(500).json({ success: false, error: "Failed to reject quote." });
  }
});

// Create order from accepted quote
quotesAdminRouter.post("/:quoteId/create-order", async (req, res) => {
  const { quoteId } = req.params;

  try {
    // Load quote with customer_id
    const { rows } = await pool.query("SELECT * FROM quotes WHERE id=$1", [quoteId]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: "Quote not found." });
    const q = rows[0];

    // Already has an order?
    const existing = await pool.query("SELECT id FROM orders WHERE quote_id=$1", [quoteId]);
    if (existing.rows.length) {
      return res.json({ success: true, order: existing.rows[0], message: "Order already exists for this quote." });
    }

    // Must be accepted to create order
    if (q.status !== "accepted") {
      return res.status(400).json({ success: false, message: "Quote must be accepted before creating an order." });
    }

    const itemsArr = toArray(q.items);
    const total = calcSubtotal(itemsArr);
    const deposit = Number(q.deposit ?? total * 0.5) || 0;
    const balance = Math.max(0, total - deposit);

    const { rows: ins } = await pool.query(
      `
      INSERT INTO orders
        (customer_id, quote_id, title, description, status, items, tasks, deposit, balance, diary, created_at, updated_at)
      VALUES
        ($1, $2, $3, $4, 'in_progress', $5, '[]', $6, $7, '[]', NOW(), NOW())
      RETURNING *;
      `,
      [q.customer_id, quoteId, q.title, q.description || "", JSON.stringify(itemsArr), deposit, balance]
    );

    // History
    await pool.query(
      `INSERT INTO quote_history (quote_id, action, feedback, actor) VALUES ($1,'converted_to_order',$2,'admin')`,
      [quoteId, null]
    );

    res.json({ success: true, order: ins[0], message: "Order created from quote." });
  } catch (err) {
    console.error("❌ Error creating order from quote:", err);
    res.status(500).json({ success: false, error: "Failed to create order." });
  }
});

// Get linked order (if any)
quotesAdminRouter.get("/:quoteId/order", async (req, res) => {
  const { quoteId } = req.params;
  try {
    const { rows } = await pool.query("SELECT * FROM orders WHERE quote_id=$1", [quoteId]);
    if (!rows.length) return res.json({ success: true, order: null });
    res.json({ success: true, order: rows[0] });
  } catch (err) {
    console.error("❌ Error fetching linked order:", err);
    res.status(500).json({ success: false, error: "Failed to fetch linked order." });
  }
});
