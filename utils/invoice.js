/**
 * ============================================================
 * PJH Web Services — Invoice Generator (2025 Final + Logo)
 * ============================================================
 * ✅ Auto-calculates balance_due
 * ✅ Professional brand layout (PJH blue/grey)
 * ✅ Includes customer + order details
 * ✅ Adds top-right PJH Web Services logo
 * ✅ Generates dynamic filenames & saves to /public/invoices
 * ✅ Compatible with email + preview routes
 * ============================================================
 */

import fs from "fs";
import path from "path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const BRAND_BLUE = rgb(0.15, 0.38, 0.92);
const LIGHT_GREY = rgb(0.97, 0.98, 1.0);
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

/**
 * Generate PDF invoice and save under /public/invoices
 * @param {Object} order - Order and customer data
 * @param {"deposit"|"balance"} type - Invoice type
 * @returns {Promise<string>} - Absolute path to saved PDF
 */
export async function generateInvoicePDF(order, type = "deposit") {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const A4 = [595, 842];
  const margin = 50;
  const width = A4[0];
  let y = A4[1] - 60;
  const page = pdfDoc.addPage(A4);

  /* ------------------------------------------------------------
     HEADER + LOGO
  ------------------------------------------------------------ */
  try {
    const logoPath = path.resolve(process.cwd(), "public", "assets", "pjh-logo-dark.png");
    if (fs.existsSync(logoPath)) {
      const logoBytes = fs.readFileSync(logoPath);
      const logoImage = await pdfDoc.embedPng(logoBytes);

      const logoWidth = 90;
      const logoHeight = (logoImage.height / logoImage.width) * logoWidth;
      page.drawImage(logoImage, {
        x: width - margin - logoWidth,
        y: A4[1] - margin - logoHeight,
        width: logoWidth,
        height: logoHeight,
      });
    } else {
      console.warn("⚠️ Logo not found at /public/assets/pjh-logo-dark.png — skipping.");
    }
  } catch (err) {
    console.warn("⚠️ Failed to embed logo:", err.message);
  }

  drawText(page, "PJH Web Services", margin, y, 16, bold, BRAND_BLUE);
  drawRightText(
    page,
    `${type === "deposit" ? "Deposit Invoice" : "Balance Invoice"}`,
    width - margin - 100,
    y,
    18,
    bold,
    BRAND_BLUE
  );
  y -= 25;
  drawText(page, "www.pjhwebservices.co.uk", margin, y, 10, font, TEXT_GREY);
  drawText(page, "info@pjhwebservices.co.uk  •  07587 707 981", margin, y - 12, 10, font, TEXT_GREY);
  y -= 30;
  drawLine(page, margin, y, width - margin, y, 2, BRAND_BLUE);
  y -= 35;

  /* ------------------------------------------------------------
     CUSTOMER INFO
  ------------------------------------------------------------ */
  const customer = order.customer || order;
  drawText(page, `To: ${customer.business || customer.name || "Customer"}`, margin, y, 12, bold);
  y -= 14;
  if (customer.address1) drawText(page, customer.address1, margin, y, 10, font);
  if (customer.city) drawText(page, customer.city, margin, y - 12, 10, font);
  if (customer.postcode) drawText(page, customer.postcode, margin, y - 24, 10, font);
  y -= 48;

  drawText(page, `Invoice #: PJH-${String(order.id).padStart(4, "0")}`, margin, y, 11, bold);
  drawRightText(page, `Date: ${new Date().toLocaleDateString("en-GB")}`, width - margin, y, 10, font);
  y -= 30;

  /* ------------------------------------------------------------
     ITEM TABLE
  ------------------------------------------------------------ */
  const items = Array.isArray(order.items)
    ? order.items
    : typeof order.items === "string"
    ? JSON.parse(order.items)
    : [];

  const tableLeft = margin;
  const tableRight = width - margin;
  const colX = {
    desc: tableLeft,
    qty: tableRight - 190,
    unit: tableRight - 120,
    total: tableRight - 50,
  };

  drawLine(page, tableLeft, y, tableRight, y, 1.5, BRAND_BLUE);
  y -= 18;
  drawText(page, "Description", colX.desc, y, 11, bold, BRAND_BLUE);
  drawRightText(page, "Qty", colX.qty + 10, y, 11, bold, BRAND_BLUE);
  drawRightText(page, "Unit (£)", colX.unit + 20, y, 11, bold, BRAND_BLUE);
  drawRightText(page, "Total (£)", colX.total + 35, y, 11, bold, BRAND_BLUE);
  y -= 12;
  drawLine(page, tableLeft, y, tableRight, y, 1, BORDER_GREY);
  y -= 10;

  let subtotal = 0;
  for (const it of items) {
    const qty = Number(it.qty || 1);
    const unit = Number(it.unit_price || it.price || 0);
    const total = qty * unit;
    subtotal += total;

    const lines = wrapByWidth(it.name || it.description || "-", 280, font, 10);
    for (const line of lines) {
      drawText(page, line, colX.desc, y, 10, font);
      y -= 12;
    }
    drawRightText(page, qty, colX.qty + 10, y + 12, 10, font);
    drawRightText(page, unit.toFixed(2), colX.unit + 20, y + 12, 10, font);
    drawRightText(page, total.toFixed(2), colX.total + 35, y + 12, 10, font);
    y -= 8;
  }

  /* ------------------------------------------------------------
     TOTALS SECTION
  ------------------------------------------------------------ */
  y -= 25;
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

  /* ------------------------------------------------------------
     FOOTER
  ------------------------------------------------------------ */
  drawText(page, "Thank you for your business!", margin, y, 11, bold, BRAND_BLUE);
  y -= 14;
  drawText(
    page,
    "Please use the payment link provided or contact PJH Web Services for assistance.",
    margin,
    y,
    9,
    font,
    TEXT_GREY
  );
  y -= 10;
  drawLine(page, margin, y, width - margin, y, 1, BORDER_GREY);
  y -= 14;
  drawText(page, "This invoice was automatically generated by PJH Web Services.", margin, y, 8, font, rgb(0.45, 0.45, 0.45));

  /* ------------------------------------------------------------
     FILE SAVE
  ------------------------------------------------------------ */
  const outDir = path.resolve(process.cwd(), "public", "invoices");
  fs.mkdirSync(outDir, { recursive: true });

  const customerName = sanitizeFilename(customer.business || customer.name || "Customer");
  const projectTitle = sanitizeFilename(order.title || "Project");
  const invoiceNumber = `INV${String(order.id).padStart(4, "0")}`;
  const fileName = `PJH-INV-${customerName}-${projectTitle}-${invoiceNumber}-${type.toUpperCase()}.pdf`;
  const outPath = path.join(outDir, fileName);

  fs.writeFileSync(outPath, await pdfDoc.save());
  console.log(`📄 Invoice saved: ${outPath}`);
  return outPath;
}
