/**
 * ============================================================
 * PJH Web Services — Quote Response & Invoice Generator
 * ============================================================
 * Handles token-based quote responses (accept / reject / amend)
 * and generates lightweight PDF invoices when needed.
 * ============================================================
 */

import express from "express";
import pool from "../db.js";
import PDFDocument from "pdfkit";

const router = express.Router();

/* -----------------------------
   Helper: Generate Invoice PDF (inline to response)
-------------------------------- */
export function generateInvoice(res, customer, quote) {
  const doc = new PDFDocument({ margin: 50 });
  const filename = `invoice-${quote.quote_number || "pjh"}.pdf`;

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  doc.pipe(res);

  // Header
  doc
    .fontSize(20)
    .text("PJH Web Services", { align: "center" })
    .moveDown(0.5);

  doc
    .fontSize(12)
    .text(`Invoice: ${quote.quote_number || "N/A"}`)
    .text(`Date: ${new Date().toLocaleDateString()}`)
    .moveDown(1);

  // Customer Info
  doc.fontSize(11).text("Bill To:");
  doc.fontSize(10)
    .text(customer.name || "")
    .text(customer.email || "")
    .text(customer.phone || "")
    .text([customer.address1, customer.address2].filter(Boolean).join(", "))
    .text([customer.city, customer.postcode].filter(Boolean).join(", "))
    .moveDown(1);

  // Quote Details
  doc.fontSize(12).text(`Project: ${quote.title || "Untitled Project"}`);
  if (quote.description) doc.fontSize(10).text(quote.description);
  doc.moveDown(0.5);

  // Items
  doc.fontSize(12).text("Items", { underline: true }).moveDown(0.3);
  (quote.items || []).forEach((item) => {
    const price = Number(item.price || 0).toFixed(2);
    doc.fontSize(10).text(`${item.name || "Item"} — £${price}`);
  });

  // Totals
  doc.moveDown(1);
  const total = (quote.total || 0).toFixed(2);
  const deposit = (quote.deposit || 0).toFixed(2);
  const balance = (quote.balance || 0).toFixed(2);

  doc
    .fontSize(11)
    .text(`Deposit: £${deposit}`)
    .text(`Balance: £${balance}`)
    .text(`Total: £${total}`)
    .moveDown(2);

  doc
    .fontSize(10)
    .text("Thank you for your business!", { align: "center" })
    .text("Payment is due within 14 days.", { align: "center" });

  doc.end();
}

/* -----------------------------
   POST /api/responses/:token/accept
-------------------------------- */
router.post("/:token/accept", async (req, res) => {
  const { token } = req.params;
  const actor = req.body?.actor || "customer";

  try {
    const { rows } = await pool.query(
      `UPDATE quotes 
       SET status='accepted', updated_at=NOW()
       WHERE response_token=$1
       RETURNING *`,
      [token]
    );

    if (rows.length === 0)
      return res.status(404).json({ success: false, message: "Quote not found." });

    const quote = rows[0];

    await pool.query(
      `INSERT INTO quote_history (quote_id, action, actor, created_at)
       VALUES ($1, 'accepted', $2, NOW())`,
      [quote.id, actor]
    );

    res.json({ success: true, message: "Quote accepted.", quote });
  } catch (err) {
    console.error("❌ Error accepting quote:", err);
    res.status(500).json({ success: false, message: "Failed to accept quote." });
  }
});

/* -----------------------------
   POST /api/responses/:token/reject
-------------------------------- */
router.post("/:token/reject", async (req, res) => {
  const { token } = req.params;
  const { feedback } = req.body || {};
  const actor = req.body?.actor || "customer";

  try {
    const { rows } = await pool.query(
      `UPDATE quotes 
       SET status='rejected', feedback=$2, updated_at=NOW()
       WHERE response_token=$1
       RETURNING *`,
      [token, feedback || null]
    );

    if (rows.length === 0)
      return res.status(404).json({ success: false, message: "Quote not found." });

    const quote = rows[0];

    await pool.query(
      `INSERT INTO quote_history (quote_id, action, feedback, actor, created_at)
       VALUES ($1, 'rejected', $2, $3, NOW())`,
      [quote.id, feedback || null, actor]
    );

    res.json({ success: true, message: "Quote rejected.", quote });
  } catch (err) {
    console.error("❌ Error rejecting quote:", err);
    res.status(500).json({ success: false, message: "Failed to reject quote." });
  }
});

/* -----------------------------
   POST /api/responses/:token/amend
-------------------------------- */
router.post("/:token/amend", async (req, res) => {
  const { token } = req.params;
  const { feedback } = req.body || {};
  const actor = req.body?.actor || "customer";

  try {
    const { rows } = await pool.query(
      `UPDATE quotes 
       SET status='amend_requested', feedback=$2, updated_at=NOW()
       WHERE response_token=$1
       RETURNING *`,
      [token, feedback || null]
    );

    if (rows.length === 0)
      return res.status(404).json({ success: false, message: "Quote not found." });

    const quote = rows[0];

    await pool.query(
      `INSERT INTO quote_history (quote_id, action, feedback, actor, created_at)
       VALUES ($1, 'amend_requested', $2, $3, NOW())`,
      [quote.id, feedback || null, actor]
    );

    res.json({ success: true, message: "Amendment requested.", quote });
  } catch (err) {
    console.error("❌ Error requesting amendment:", err);
    res.status(500).json({ success: false, message: "Failed to request amendment." });
  }
});

export default router;
