/**
 * ============================================================
 * PJH Web Services — Quotes API (2025 Streamlined)
 * ============================================================
 * Simplified:
 *   • Removed accept/reject/amend logic
 *   • Only supports "pending" or "closed"
 *   • Convert to order remains intact
 * ============================================================
 */

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import pool, { generateQuoteNumber } from "../db.js";
import { generateResponseToken } from "../utils/token.js";
import { sendEmail } from "../utils/email.js";
import { generateQuotePDF } from "../utils/pdf.js";
import { toArray, calcSubtotal, findQuote } from "../utils/quotes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const quotesCustomerRouter = express.Router();
export const quotesAdminRouter = express.Router();

/* ============================================================
   CUSTOMER ROUTES
   ============================================================ */

// ➕ Create Quote
quotesCustomerRouter.post("/:id/quotes", async (req, res) => {
  const { id } = req.params;
  const {
    title,
    description,
    items,
    deposit,
    notes,
    package_id,
    custom_price,
    discount_percent,
  } = req.body;

  try {
    const { rows: cRows } = await pool.query("SELECT * FROM customers WHERE id=$1", [id]);
    if (!cRows.length)
      return res.status(404).json({ success: false, error: "Customer not found." });

    const quoteNumber = await generateQuoteNumber(id, cRows[0].business || cRows[0].name);

    const { rows } = await pool.query(
      `
      INSERT INTO quotes (
        customer_id, quote_number, title, description, items, deposit, notes,
        package_id, custom_price, discount_percent, status, response_token,
        created_at, updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11,NOW(),NOW())
      RETURNING *;
      `,
      [
        id,
        quoteNumber,
        title || "",
        description || "",
        JSON.stringify(toArray(items)),
        deposit ?? null,
        notes || "",
        package_id || null,
        custom_price || null,
        discount_percent || 0,
        generateResponseToken(),
      ]
    );

    console.log(`📝 Quote created for customer ${id}: ${quoteNumber}`);
    res.status(201).json({ success: true, quote: rows[0] });
  } catch (err) {
    console.error("❌ Error creating quote:", err);
    res.status(500).json({ success: false, error: "Failed to create quote." });
  }
});

// 📋 List Quotes (Customer)
quotesCustomerRouter.get("/:id/quotes", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM quotes WHERE customer_id=$1 ORDER BY created_at DESC",
      [req.params.id]
    );
    res.json({ success: true, quotes: rows.map((q) => ({ ...q, items: toArray(q.items) })) });
  } catch (err) {
    console.error("❌ Error fetching quotes:", err);
    res.status(500).json({ success: false, error: "Failed to fetch quotes." });
  }
});

// 🧾 Get Single Quote
quotesCustomerRouter.get("/:id/quotes/:quoteId", async (req, res) => {
  const { id, quoteId } = req.params;
  try {
    const { rows } = await pool.query("SELECT * FROM quotes WHERE id=$1 AND customer_id=$2", [
      quoteId,
      id,
    ]);
    if (!rows.length)
      return res.status(404).json({ success: false, error: "Quote not found." });
    res.json({ success: true, quote: { ...rows[0], items: toArray(rows[0].items) } });
  } catch (err) {
    console.error("❌ Error fetching quote:", err);
    res.status(500).json({ success: false, error: "Failed to fetch quote." });
  }
});

// ✏️ Update Quote
quotesCustomerRouter.put("/:id/quotes/:quoteId", async (req, res) => {
  const { id, quoteId } = req.params;
  const q = req.body;
  try {
    const exists = await findQuote(quoteId);
    if (!exists || exists.customer_id !== Number(id))
      return res.status(404).json({ success: false, error: "Quote not found." });

    await pool.query(
      `
      UPDATE quotes
      SET title=$1, description=$2, items=$3, deposit=$4, notes=$5,
          package_id=$6, custom_price=$7, discount_percent=$8, updated_at=NOW()
      WHERE id=$9;
      `,
      [
        q.title || "",
        q.description || "",
        JSON.stringify(toArray(q.items)),
        q.deposit ?? null,
        q.notes || "",
        q.package_id || null,
        q.custom_price || null,
        q.discount_percent || 0,
        quoteId,
      ]
    );

    res.json({ success: true, message: "Quote updated successfully." });
  } catch (err) {
    console.error("❌ Error updating quote:", err);
    res.status(500).json({ success: false, error: "Failed to update quote." });
  }
});

// ❌ Delete Quote
quotesCustomerRouter.delete("/:id/quotes/:quoteId", async (req, res) => {
  const { id, quoteId } = req.params;
  try {
    const result = await pool.query(
      "DELETE FROM quotes WHERE id=$1 AND customer_id=$2 RETURNING id, quote_number, title",
      [quoteId, id]
    );
    if (!result.rows.length)
      return res.status(404).json({ success: false, message: "Quote not found." });

    console.log(`🗑️ Quote deleted by customer ${id}: ${result.rows[0].quote_number}`);
    res.json({ success: true, deleted: result.rows[0] });
  } catch (err) {
    console.error("❌ Error deleting quote:", err);
    res.status(500).json({ success: false, error: "Failed to delete quote." });
  }
});

/* ============================================================
   ADMIN ROUTES
   ============================================================ */

// 🔍 Get One (Admin)
quotesAdminRouter.get("/:quoteId", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT q.*, c.name AS customer_name, c.business AS customer_business,
             c.email AS customer_email, c.phone AS customer_phone,
             c.address1, c.address2, c.city, c.county, c.postcode,
             o.id AS order_id
      FROM quotes q
      JOIN customers c ON q.customer_id = c.id
      LEFT JOIN orders o ON o.quote_id = q.id
      WHERE q.id = $1;
      `,
      [req.params.quoteId]
    );

    if (!rows.length)
      return res.status(404).json({ success: false, message: "Quote not found." });

    const quote = rows[0];
    quote.items = toArray(quote.items);
    res.json({ success: true, quote });
  } catch (err) {
    console.error("❌ Error fetching admin quote:", err);
    res.status(500).json({ success: false, message: "Failed to fetch quote." });
  }
});

// ✏️ Update (Admin)
quotesAdminRouter.put("/:quoteId", async (req, res) => {
  const { quoteId } = req.params;
  const q = req.body;
  try {
    const exists = await findQuote(quoteId);
    if (!exists)
      return res.status(404).json({ success: false, error: "Quote not found." });

    await pool.query(
      `
      UPDATE quotes
      SET title=$1, description=$2, items=$3, deposit=$4, notes=$5,
          status=COALESCE($6,status), package_id=$7, custom_price=$8,
          discount_percent=$9, updated_at=NOW()
      WHERE id=$10;
      `,
      [
        q.title || "",
        q.description || "",
        JSON.stringify(toArray(q.items)),
        q.deposit ?? null,
        q.notes || "",
        q.status ?? null,
        q.package_id || null,
        q.custom_price || null,
        q.discount_percent || 0,
        quoteId,
      ]
    );

    res.json({ success: true, message: "Quote updated successfully." });
  } catch (err) {
    console.error("❌ Error updating admin quote:", err);
    res.status(500).json({ success: false, error: "Failed to update quote." });
  }
});

// ❌ Delete (Admin)
quotesAdminRouter.delete("/:quoteId", async (req, res) => {
  try {
    const { rows } = await pool.query("DELETE FROM quotes WHERE id=$1 RETURNING *;", [
      req.params.quoteId,
    ]);
    if (!rows.length)
      return res.status(404).json({ success: false, message: "Quote not found." });
    console.log(`🗑️ Admin deleted quote: ${rows[0].quote_number}`);
    res.json({ success: true, deleted: rows[0] });
  } catch (err) {
    console.error("❌ Error deleting quote:", err);
    res.status(500).json({ success: false, error: "Failed to delete quote." });
  }
});

// 📧 Email Quote (Admin)
quotesAdminRouter.post("/:quoteId/email", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT q.*, c.name AS customer_name, c.business AS customer_business,
             c.email AS customer_email, c.phone AS customer_phone,
             c.address1, c.address2, c.city, c.county, c.postcode
      FROM quotes q
      JOIN customers c ON q.customer_id = c.id
      WHERE q.id = $1;
      `,
      [req.params.quoteId]
    );

    if (!rows.length)
      return res.status(404).json({ success: false, message: "Quote not found." });

    const quote = rows[0];
    const pdfPath = await generateQuotePDF(quote);

    await sendEmail({
      to: quote.customer_email,
      subject: `Quote #${quote.quote_number} from PJH Web Services`,
      text: `Dear ${quote.customer_business || quote.customer_name || "Customer"},\n\nPlease find attached your quote.\n\nKind regards,\nPJH Web Services`,
      attachments: [{ filename: path.basename(pdfPath), path: pdfPath }],
    });

    console.log(`📧 Quote #${quote.quote_number} emailed to ${quote.customer_email}`);
    res.json({ success: true, message: "Quote emailed successfully." });
  } catch (err) {
    console.error("❌ Error emailing quote:", err);
    res.status(500).json({ success: false, error: "Failed to email quote." });
  }
});

// 👁️ Preview Quote (Admin)
quotesAdminRouter.post("/:quoteId/preview", async (req, res) => {
  const { quoteId } = req.params;

  try {
    const { rows } = await pool.query(
      `
      SELECT q.*, c.business AS customer_business, c.name AS customer_name,
             c.email AS customer_email, c.phone AS customer_phone,
             c.address1, c.address2, c.city, c.county, c.postcode
      FROM quotes q
      LEFT JOIN customers c ON q.customer_id = c.id
      WHERE q.id = $1;
      `,
      [quoteId]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, error: "Quote not found." });
    }

    const quote = { ...rows[0], ...req.body };
    const pdfPath = await generateQuotePDF(quote);
    const pdfBuffer = fs.readFileSync(pdfPath);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="Quote-${quoteId}-preview.pdf"`);
    res.send(pdfBuffer);

    setTimeout(() => fs.unlink(pdfPath, () => {}), 30000);
  } catch (err) {
    console.error("❌ Preview quote failed:", err);
    res.status(500).json({ success: false, error: "Failed to generate quote preview." });
  }
});

// 🧩 Create Order from Quote
quotesAdminRouter.post("/:quoteId/create-order", async (req, res) => {
  const { quoteId } = req.params;
  try {
    const q = await findQuote(quoteId);
    if (!q)
      return res.status(404).json({ success: false, message: "Quote not found." });

    const existing = await pool.query("SELECT id FROM orders WHERE quote_id=$1", [quoteId]);
    if (existing.rows.length)
      return res.json({ success: true, order: existing.rows[0], message: "Order already exists." });

    const total = calcSubtotal(q.items);
    const deposit = Number(q.deposit ?? total * 0.5);
    const balance = Math.max(0, total - deposit);

    const { rows } = await pool.query(
      `
      INSERT INTO orders (
        customer_id, quote_id, title, description, status, items, tasks, deposit, balance, diary, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,'in_progress',$5,'[]',$6,$7,'[]',NOW(),NOW())
      RETURNING *;
      `,
      [
        q.customer_id,
        quoteId,
        q.title,
        q.description || "",
        JSON.stringify(toArray(q.items)),
        deposit,
        balance,
      ]
    );

    await pool.query(
      "UPDATE quotes SET status='closed', updated_at=NOW() WHERE id=$1;",
      [quoteId]
    );

    res.json({ success: true, order: rows[0], message: "Order created from quote." });
  } catch (err) {
    console.error("❌ Error creating order from quote:", err);
    res.status(500).json({ success: false, error: "Failed to create order." });
  }
});
