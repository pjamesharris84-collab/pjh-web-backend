/**
 * ============================================================
 * PJH Web Services — Quote PDF Generator (2025 Update)
 * ============================================================
 * Features:
 *  • Matches new AdminQuoteRecord.js (weighted line items & discounts)
 *  • Includes global discount, deposit, and balance sections
 *  • Auto-wraps long text for perfect print layout
 *  • Professional layout with brand colors, logo, and footer
 * ============================================================
 */

import fs from "fs";
import path from "path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

// -----------------------------------------------------------------------------
// BRAND COLOURS
// -----------------------------------------------------------------------------
const BRAND_BLUE = rgb(0.15, 0.38, 0.92); // #2563EB
const LIGHT_GREY = rgb(0.96, 0.97, 0.99);
const BORDER_GREY = rgb(0.8, 0.8, 0.85);
const TEXT_GREY = rgb(0.15, 0.15, 0.15);

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------
function sanitizeFilename(str) {
  return String(str || "")
    .replace(/[\/\\?%*:|"<>]/g, "_")
    .replace(/\s+/g, "_")
    .trim();
}

function numberOrZero(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

function wrapByWidth(text, maxWidth, font, size) {
  if (!text) return [""];
  const words = String(text).split(/\s+/);
  const lines = [];
  let current = "";
  for (const w of words) {
    const candidate = current ? current + " " + w : w;
    const width = font.widthOfTextAtSize(candidate, size);
    if (width > maxWidth) {
      if (current) lines.push(current);
      current = w;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function drawLine(page, x1, y1, x2, y2, thickness = 1, color = BORDER_GREY) {
  page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, color });
}

function drawRightText(page, text, xRight, y, size, font, color = TEXT_GREY) {
  const w = font.widthOfTextAtSize(String(text ?? ""), size);
  page.drawText(String(text ?? ""), { x: xRight - w, y, size, font, color });
}

function drawText(page, text, x, y, size, font, color = TEXT_GREY) {
  page.drawText(String(text ?? ""), { x, y, size, font, color });
}

// -----------------------------------------------------------------------------
// MAIN GENERATOR
// -----------------------------------------------------------------------------
export async function generateQuotePDF(row) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // Layout constants
  const A4 = [595, 842];
  const margin = 50;
  const contentRight = A4[0] - margin;
  const footerY = 62;
  const minBottomY = 110;
  const bodySize = 10;
  const h1 = 16;
  const h2 = 13;

  // ---------------------------------------------------------------------------
  // PAGE 1
  // ---------------------------------------------------------------------------
  let page = pdfDoc.addPage(A4);
  let { width, height } = page.getSize();
  let y = height - 60;

  // Try to load logo
  const logoPath = path.resolve(process.cwd(), "client", "public", "pjh-logo-dark.png");
  let logoHeight = 0;
  try {
    if (fs.existsSync(logoPath)) {
      const bytes = fs.readFileSync(logoPath);
      const img = await pdfDoc.embedPng(bytes);
      const logoWidth = 200;
      const scale = logoWidth / img.width;
      logoHeight = img.height * scale;
      page.drawImage(img, {
        x: margin,
        y: y - logoHeight,
        width: logoWidth,
        height: logoHeight,
      });
    } else {
      drawText(page, "PJH Web Services", margin, y - 12, h2, bold);
      logoHeight = 20;
    }
  } catch {
    drawText(page, "PJH Web Services", margin, y - 12, h2, bold);
    logoHeight = 20;
  }

  // Contact details (right)
  drawRightText(page, "PJH Web Services", contentRight, y - 5, h2, bold);
  drawRightText(page, "Professional Digital Services", contentRight, y - 22, bodySize, font);
  drawRightText(page, "www.pjhwebservices.co.uk", contentRight, y - 38, bodySize, font);
  drawRightText(page, "info@pjhwebservices.co.uk", contentRight, y - 54, bodySize, font);
  drawRightText(page, "07587 707981", contentRight, y - 70, bodySize, font);

  y -= Math.max(logoHeight, 90) + 10;
  drawLine(page, margin, y, width - margin, y, 2, BRAND_BLUE);
  y -= 26;

  // Meta info
  const issued = new Date(row.created_at || Date.now());
  drawText(page, `Quote # ${row.quote_number || row.id}`, margin, y, h1, bold);
  y -= 18;
  drawText(page, `Date: ${issued.toLocaleDateString()}`, margin, y, bodySize, font);
  y -= 14;
  drawText(
    page,
    `Valid Until: ${new Date(issued.getTime() + 90 * 86400000).toLocaleDateString()}`,
    margin,
    y,
    bodySize,
    font
  );

  // Customer box
  const blockW = 270;
  const blockH = 130;
  const blockX = width - margin - blockW;
  const blockY = y - 6 - blockH;

  page.drawRectangle({
    x: blockX,
    y: blockY,
    width: blockW,
    height: blockH,
    color: LIGHT_GREY,
    borderWidth: 1,
    borderColor: BORDER_GREY,
  });

  const customer =
    row.customer_business || row.customer_name || row.business || row.name || "Customer";
  const addressLines = [row.address1, row.address2, row.city, row.county, row.postcode].filter(
    Boolean
  );
  const contactName = row.customer_name || row.contact_name || "";
  const email = row.customer_email || row.email || "";
  const phone = row.customer_phone || row.phone || "";

  let yBlock = blockY + blockH - 16;
  drawText(page, customer, blockX + 10, yBlock, bodySize, bold);
  yBlock -= 14;
  for (const line of addressLines) {
    drawText(page, line, blockX + 10, yBlock, bodySize, font);
    yBlock -= 12;
  }
  if (contactName) {
    yBlock -= 4;
    drawText(page, contactName, blockX + 10, yBlock, bodySize, font);
    yBlock -= 12;
  }
  if (email) {
    drawText(page, email, blockX + 10, yBlock, bodySize, font);
    yBlock -= 12;
  }
  if (phone) {
    drawText(page, phone, blockX + 10, yBlock, bodySize, font);
  }

  y = blockY - 30;
  drawText(page, "Project:", margin, y, h2, bold);
  drawText(page, String(row.title || "-"), margin + 70, y, bodySize, font);
  y -= 16;

  // Description
  const descLines = wrapByWidth(String(row.description || "-"), width - margin * 2, font, bodySize);
  for (const line of descLines) {
    if (y < minBottomY) {
      drawFooter(page, font);
      page = pdfDoc.addPage(A4);
      y = height - 80;
    }
    drawText(page, line, margin, y, bodySize, font);
    y -= 12;
  }
  y -= 8;

  // ---------------------------------------------------------------------------
  // ITEMS TABLE
  // ---------------------------------------------------------------------------
  const tableLeft = margin;
  const tableWidth = width - margin * 2;
  const colWidths = [250, 60, 80, 60, 70]; // + discount column
  const colPad = 8;
  const colX = [
    tableLeft,
    tableLeft + colWidths[0],
    tableLeft + colWidths[0] + colWidths[1],
    tableLeft + colWidths[0] + colWidths[1] + colWidths[2],
    tableLeft + colWidths[0] + colWidths[1] + colWidths[2] + colWidths[3],
  ];

  const drawTableHeader = () => {
    const headerH = 24;
    page.drawRectangle({
      x: tableLeft,
      y: y - headerH,
      width: tableWidth,
      height: headerH,
      color: BRAND_BLUE,
    });
    const white = rgb(1, 1, 1);
    drawText(page, "Description", colX[0] + colPad, y - 16, bodySize, bold, white);
    drawRightText(page, "Qty", colX[1] + colWidths[1] - colPad, y - 16, bodySize, bold, white);
    drawRightText(page, "Unit (£)", colX[2] + colWidths[2] - colPad, y - 16, bodySize, bold, white);
    drawRightText(page, "Disc %", colX[3] + colWidths[3] - colPad, y - 16, bodySize, bold, white);
    drawRightText(page, "Total (£)", colX[4] + colWidths[4] - colPad, y - 16, bodySize, bold, white);
    y -= headerH;
  };

  const ensureSpace = (needed) => {
    if (y - needed < minBottomY) {
      drawFooter(page, font);
      page = pdfDoc.addPage(A4);
      y = height - 80;
      page.drawRectangle({ x: 0, y: height - 70, width, height: 40, color: BRAND_BLUE });
      drawText(page, "Quote Items (continued)", margin, height - 55, h2, bold, rgb(1, 1, 1));
      y -= 90;
      drawTableHeader();
    }
  };

  drawTableHeader();

  const items =
    Array.isArray(row.items) && row.items.length
      ? row.items
      : typeof row.items === "string"
      ? JSON.parse(row.items || "[]")
      : [];

  let subtotal = 0;
  for (const it of items) {
    const qty = numberOrZero(it.qty || 1);
    const unit = numberOrZero(it.unit_price ?? it.price ?? 0);
    const disc = Math.min(Math.max(numberOrZero(it.discount_percent || 0), 0), 100);
    const gross = qty * unit;
    const net = gross * (1 - disc / 100);
    subtotal += net;

    const descLines = wrapByWidth(it.name || "-", colWidths[0] - colPad * 2, font, bodySize);
    const lineHeight = 13;
    const rowHeight = Math.max(20, descLines.length * lineHeight + 6);

    ensureSpace(rowHeight);

    page.drawRectangle({
      x: tableLeft,
      y: y - rowHeight,
      width: tableWidth,
      height: rowHeight,
      color: LIGHT_GREY,
      borderWidth: 0.5,
      borderColor: BORDER_GREY,
    });

    let yy = y - 14;
    for (const line of descLines) {
      drawText(page, line, colX[0] + colPad, yy, bodySize, font);
      yy -= lineHeight;
    }

    drawRightText(page, qty, colX[1] + colWidths[1] - colPad, y - 14, bodySize, font);
    drawRightText(page, unit.toFixed(2), colX[2] + colWidths[2] - colPad, y - 14, bodySize, font);
    drawRightText(page, disc.toFixed(1), colX[3] + colWidths[3] - colPad, y - 14, bodySize, font);
    drawRightText(page, net.toFixed(2), colX[4] + colWidths[4] - colPad, y - 14, bodySize, font);

    y -= rowHeight;
  }

  // ---------------------------------------------------------------------------
  // TOTALS SECTION
  // ---------------------------------------------------------------------------
  const globalDisc = numberOrZero(row.discount_percent || 0);
  const afterGlobal = subtotal * (1 - globalDisc / 100);
  const deposit = numberOrZero(row.deposit ?? afterGlobal * 0.5);
  const balance = Math.max(afterGlobal - deposit, 0);

  y -= 24;
  ensureSpace(80);

  const totalsBoxW = 260;
  const totalsBoxX = contentRight - totalsBoxW;
  const totalsBoxY = y - 70;

  page.drawRectangle({
    x: totalsBoxX,
    y: totalsBoxY,
    width: totalsBoxW,
    height: 70,
    borderWidth: 1,
    borderColor: BRAND_BLUE,
    color: rgb(0.97, 0.98, 1),
  });

  drawText(page, "Subtotal:", totalsBoxX + 12, totalsBoxY + 54, bodySize, font);
  drawRightText(page, `£${subtotal.toFixed(2)}`, totalsBoxX + totalsBoxW - 10, totalsBoxY + 54, bodySize, font);

  drawText(page, `Global Discount (${globalDisc.toFixed(1)}%):`, totalsBoxX + 12, totalsBoxY + 38, bodySize, font);
  drawRightText(page, `£${afterGlobal.toFixed(2)}`, totalsBoxX + totalsBoxW - 10, totalsBoxY + 38, bodySize, font);

  drawText(page, "Deposit Required:", totalsBoxX + 12, totalsBoxY + 22, bodySize, bold);
  drawRightText(page, `£${deposit.toFixed(2)}`, totalsBoxX + totalsBoxW - 10, totalsBoxY + 22, bodySize, bold);

  drawText(page, "Balance Remaining:", totalsBoxX + 12, totalsBoxY + 6, bodySize, font);
  drawRightText(page, `£${balance.toFixed(2)}`, totalsBoxX + totalsBoxW - 10, totalsBoxY + 6, bodySize, font);

  y = totalsBoxY - 30;
  drawText(page, "Thank you for your business!", margin, y, bodySize + 1, bold, BRAND_BLUE);

  // Footer
  drawFooter(page, font);

  // ---------------------------------------------------------------------------
  // TERMS PAGE
  // ---------------------------------------------------------------------------
  const termsPage = pdfDoc.addPage(A4);
  let y2 = A4[1] - 80;
  termsPage.drawRectangle({ x: 0, y: A4[1] - 70, width: A4[0], height: 40, color: BRAND_BLUE });
  drawText(termsPage, "Terms & Conditions", margin, A4[1] - 55, h2, bold, rgb(1, 1, 1));
  y2 -= 30;

  const terms = [
    ["1. Payments", "A 50% deposit is required before work begins. Balance due upon completion before website launch."],
    ["2. Ownership", "All deliverables remain PJH Web Services property until full payment is received."],
    ["3. Scope", "Quoted work includes only listed features. Major scope changes may incur additional charges."],
    ["4. Support", "Post-launch support is not included unless part of a maintenance package."],
    ["5. Liability", "PJH Web Services is not liable for third-party outages or client-side content errors."],
  ];

  for (const [title, body] of terms) {
    if (y2 < footerY + 40) {
      drawFooter(termsPage, font);
      const tp = pdfDoc.addPage(A4);
      y2 = A4[1] - 80;
      tp.drawRectangle({ x: 0, y: A4[1] - 70, width: A4[0], height: 40, color: BRAND_BLUE });
      drawText(tp, "Terms & Conditions (continued)", margin, A4[1] - 55, h2, bold, rgb(1, 1, 1));
      drawFooter(tp, font);
    }
    drawText(termsPage, title, margin, y2, bodySize + 1, bold, BRAND_BLUE);
    y2 -= 14;
    const lines = wrapByWidth(body, A4[0] - margin * 2, font, bodySize);
    for (const l of lines) {
      drawText(termsPage, l, margin, y2, bodySize, font);
      y2 -= 12;
    }
    y2 -= 6;
  }

  drawFooter(termsPage, font);

  // ---------------------------------------------------------------------------
  // SAVE PDF
  // ---------------------------------------------------------------------------
  const outDir = path.resolve(process.cwd(), "generated", "quotes");
  fs.mkdirSync(outDir, { recursive: true });
  const nameForFile = sanitizeFilename(
    row.customer_business || row.customer_name || row.business || row.name || "Customer"
  );
  const qno = sanitizeFilename(row.quote_number || row.id);
  const fileName = `PJH_Web_Services_${nameForFile}_Quote_${qno}.pdf`;
  const outPath = path.join(outDir, fileName);

  fs.writeFileSync(outPath, await pdfDoc.save());
  console.log(`📄 Quote PDF saved: ${outPath}`);
  return outPath;

  // ---------------------------------------------------------------------------
  // FOOTER
  // ---------------------------------------------------------------------------
  function drawFooter(p, fnt) {
    drawLine(p, margin, footerY, A4[0] - margin, footerY, 2, BRAND_BLUE);
    drawText(
      p,
      "PJH Web Services — www.pjhwebservices.co.uk — info@pjhwebservices.co.uk — 07587 707981",
      margin,
      44,
      9,
      fnt,
      TEXT_GREY
    );
  }
}
