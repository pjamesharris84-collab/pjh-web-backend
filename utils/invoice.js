/**
 * ============================================================
 * PJH Web Services — Invoice Generator (2025 Update)
 * ============================================================
 * - Auto-calculates correct balance due
 * - Professional brand layout (blue/grey)
 * - Includes customer + order info
 * - Pulls total_paid and balance_due from DB
 * ============================================================
 */

import fs from "fs";
import path from "path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const BRAND_BLUE = rgb(0.15, 0.38, 0.92);
const LIGHT_GREY = rgb(0.96, 0.97, 0.99);
const BORDER_GREY = rgb(0.8, 0.8, 0.85);
const TEXT_GREY = rgb(0.15, 0.15, 0.15);

function sanitizeFilename(str) {
  return String(str || "")
    .replace(/[\/\\?%*:|"<>]/g, "_")
    .replace(/\s+/g, "_")
    .trim();
}

function wrapByWidth(text, maxWidth, font, size) {
  const words = String(text || "").split(/\s+/);
  const lines = [];
  let current = "";
  for (const w of words) {
    const candidate = current ? current + " " + w : w;
    const width = font.widthOfTextAtSize(candidate, size);
    if (width > maxWidth) {
      lines.push(current);
      current = w;
    } else current = candidate;
  }
  if (current) lines.push(current);
  return lines;
}

function drawText(page, text, x, y, size, font, color = TEXT_GREY) {
  page.drawText(String(text || ""), { x, y, size, font, color });
}

function drawRightText(page, text, xRight, y, size, font, color = TEXT_GREY) {
  const w = font.widthOfTextAtSize(String(text || ""), size);
  page.drawText(String(text || ""), { x: xRight - w, y, size, font, color });
}

function drawLine(page, x1, y1, x2, y2, thickness = 1, color = BORDER_GREY) {
  page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, color });
}

export async function generateInvoicePDF(order, type = "deposit") {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const A4 = [595, 842];
  const margin = 50;
  const width = A4[0];
  let y = A4[1] - 60;

  const page = pdfDoc.addPage(A4);

  // === HEADER ===
  drawText(page, "PJH Web Services", margin, y, 16, bold, BRAND_BLUE);
  drawRightText(page, "Invoice", width - margin, y, 18, bold, BRAND_BLUE);
  y -= 25;
  drawText(page, "www.pjhwebservices.co.uk", margin, y, 10, font, TEXT_GREY);
  y -= 20;
  drawLine(page, margin, y, width - margin, y, 2, BRAND_BLUE);
  y -= 30;

  // === CUSTOMER INFO ===
  const customer = order.customer || order;
  drawText(page, `To: ${customer.business || customer.name}`, margin, y, 12, bold);
  y -= 14;
  if (customer.address1) drawText(page, customer.address1, margin, y, 10, font);
  if (customer.city) drawText(page, customer.city, margin, y - 12, 10, font);
  if (customer.postcode) drawText(page, customer.postcode, margin, y - 24, 10, font);
  y -= 48;

  drawText(page, `Invoice #${order.id}`, margin, y, 12, bold);
  drawRightText(page, `Date: ${new Date().toLocaleDateString()}`, width - margin, y, 10, font);
  y -= 30;

  // === ITEMS ===
  const items = Array.isArray(order.items)
    ? order.items
    : typeof order.items === "string"
    ? JSON.parse(order.items)
    : [];
  const tableLeft = margin;
  const tableRight = width - margin;
  const colWidths = [280, 70, 90, 80];
  const colX = [tableLeft, tableLeft + colWidths[0], tableLeft + 350, tableRight - 80];
  const headerH = 20;

  drawLine(page, tableLeft, y, tableRight, y, 1, BRAND_BLUE);
  y -= headerH;
  drawText(page, "Description", colX[0], y, 11, bold, BRAND_BLUE);
  drawRightText(page, "Qty", colX[1] + 20, y, 11, bold, BRAND_BLUE);
  drawRightText(page, "Unit (£)", colX[2] + 30, y, 11, bold, BRAND_BLUE);
  drawRightText(page, "Total (£)", colX[3] + 70, y, 11, bold, BRAND_BLUE);
  y -= 15;
  drawLine(page, tableLeft, y, tableRight, y, 1, BORDER_GREY);
  y -= 10;

  let subtotal = 0;
  for (const it of items) {
    const qty = Number(it.qty || 1);
    const unit = Number(it.unit_price || it.price || 0);
    const total = qty * unit;
    subtotal += total;
    const lines = wrapByWidth(it.name || "-", colWidths[0] - 20, font, 10);
    for (const line of lines) {
      drawText(page, line, colX[0], y, 10, font);
      y -= 12;
    }
    drawRightText(page, qty, colX[1] + 20, y + 12, 10, font);
    drawRightText(page, unit.toFixed(2), colX[2] + 30, y + 12, 10, font);
    drawRightText(page, total.toFixed(2), colX[3] + 70, y + 12, 10, font);
    y -= 8;
  }

  // === TOTALS ===
  y -= 20;
  drawLine(page, tableLeft, y, tableRight, y, 1, BORDER_GREY);
  y -= 18;

  const deposit = Number(order.deposit || 0);
  const balance = Number(order.balance || 0);
  const totalPaid = Number(order.total_paid || 0);
  const balanceDue = Number(order.balance_due ?? Math.max(deposit + balance - totalPaid, 0));

  drawRightText(page, "Project Total:", tableRight - 150, y, 11, bold);
  drawRightText(page, `£${(deposit + balance).toFixed(2)}`, tableRight, y, 11, bold);
  y -= 14;
  drawRightText(page, "Paid to Date:", tableRight - 150, y, 11, font);
  drawRightText(page, `£${totalPaid.toFixed(2)}`, tableRight, y, 11, font);
  y -= 14;
  drawRightText(page, "Balance Due:", tableRight - 150, y, 11, bold, BRAND_BLUE);
  drawRightText(page, `£${balanceDue.toFixed(2)}`, tableRight, y, 11, bold, BRAND_BLUE);
  y -= 40;

  drawText(page, "Thank you for your business!", margin, y, 11, bold, BRAND_BLUE);

  // === SAVE FILE ===
  const outDir = path.resolve(process.cwd(), "generated", "invoices");
  fs.mkdirSync(outDir, { recursive: true });
  const customerName = sanitizeFilename(customer.business || customer.name || "Customer");
  const projectTitle = sanitizeFilename(order.title || "Project");
  const invoiceNumber = `INV${String(order.id).padStart(4, "0")}`;
  const fileName = `PJH_${customerName}_${projectTitle}_${invoiceNumber}_${type.toUpperCase()}.pdf`;
  const outPath = path.join(outDir, fileName);
  fs.writeFileSync(outPath, await pdfDoc.save());

  console.log(`📄 Invoice saved: ${outPath}`);
  return outPath;
}
