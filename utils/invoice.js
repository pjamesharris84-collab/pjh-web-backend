import fs from "fs";
import path from "path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

// -----------------------------------------------------------------------------
// BRAND COLOURS — identical to Quote PDF
// -----------------------------------------------------------------------------
const BRAND_BLUE = rgb(0.15, 0.38, 0.92);
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
    } else current = candidate;
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
export async function generateInvoicePDF(order, type = "deposit") {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const invoiceType =
    typeof type === "string"
      ? type
      : (type?.type && typeof type.type === "string" ? type.type : "deposit");

  // Layout
  const A4 = [595, 842];
  const margin = 50;
  const contentRight = A4[0] - margin;
  const footerY = 62;
  const minBottomY = 110;
  const bodySize = 10;
  const h1 = 16;
  const h2 = 13;

  let page = pdfDoc.addPage(A4);
  let { width, height } = page.getSize();
  let y = height - 60;

  // -----------------------------
  // HEADER / LOGO
  // -----------------------------
  const logoPath = path.resolve(process.cwd(), "client", "public", "pjh-logo-dark.png");
  let logoHeight = 0;
  try {
    if (fs.existsSync(logoPath)) {
      const bytes = fs.readFileSync(logoPath);
      const img = await pdfDoc.embedPng(bytes);
      const logoWidth = 200;
      const scale = logoWidth / img.width;
      logoHeight = img.height * scale;
      page.drawImage(img, { x: margin, y: y - logoHeight, width: logoWidth, height: logoHeight });
    } else {
      drawText(page, "PJH Web Services", margin, y - 12, h2, bold);
      logoHeight = 20;
    }
  } catch {
    drawText(page, "PJH Web Services", margin, y - 12, h2, bold);
    logoHeight = 20;
  }

  drawRightText(page, "PJH Web Services", contentRight, y - 5, h2, bold);
  drawRightText(page, "Professional Digital Services", contentRight, y - 22, bodySize, font);
  drawRightText(page, "www.pjhwebservices.co.uk", contentRight, y - 38, bodySize, font);
  drawRightText(page, "info@pjhwebservices.co.uk", contentRight, y - 54, bodySize, font);
  drawRightText(page, "07587 707981", contentRight, y - 70, bodySize, font);

  y -= Math.max(logoHeight, 90) + 10;
  drawLine(page, margin, y, width - margin, y, 2, BRAND_BLUE);
  y -= 26;

  // -----------------------------
  // META + CUSTOMER BLOCK
  // -----------------------------
  const metaX = margin;
  let metaY = y;
  const issued = new Date(order.created_at || Date.now());
  drawText(page, `Invoice # ${order.id}`, metaX, metaY, h1, bold);
  metaY -= 18;
  drawText(page, `Date: ${issued.toLocaleDateString()}`, metaX, metaY, bodySize, font);
  metaY -= 14;
  drawText(page, `Type: ${invoiceType.toUpperCase()}`, metaX, metaY, bodySize, font);

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

  const c = order.customer || order;
  let yBlock = blockY + blockH - 16;
  const customerName = c.business || c.name || "Customer";
  const addressLines = [c.address1, c.address2, c.city, c.county, c.postcode].filter(Boolean);
  const contactName = c.contact_name || c.name || "";
  const email = c.email || "";
  const phone = c.phone || "";

  drawText(page, customerName, blockX + 10, yBlock, bodySize, bold);
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
    yBlock -= 12;
  }

  // -----------------------------
  // PROJECT INFO
  // -----------------------------
  y = Math.min(metaY, blockY) - 24;
  drawText(page, "Project:", margin, y, h2, bold);
  drawText(page, String(order.title || "-"), margin + 70, y, bodySize, font);
  y -= 16;

  const descLines = wrapByWidth(String(order.description || "-"), width - margin * 2, font, bodySize);
  for (const line of descLines) {
    drawText(page, line, margin, y, bodySize, font);
    y -= 12;
  }
  y -= 8;

  // -----------------------------
  // ITEMS TABLE
  // -----------------------------
  const tableLeft = margin;
  const tableWidth = width - margin * 2;
  const colWidths = [285, 60, 80, 70];
  const colPad = 8;
  const colX = [
    tableLeft,
    tableLeft + colWidths[0],
    tableLeft + colWidths[0] + colWidths[1],
    tableLeft + colWidths[0] + colWidths[1] + colWidths[2],
  ];

  const drawTableHeader = () => {
    const headerH = 24;
    page.drawRectangle({ x: tableLeft, y: y - headerH, width: tableWidth, height: headerH, color: BRAND_BLUE });
    drawText(page, "Description", colX[0] + colPad, y - 16, bodySize, bold, rgb(1, 1, 1));
    drawRightText(page, "Qty", colX[1] + colWidths[1] - colPad, y - 16, bodySize, bold, rgb(1, 1, 1));
    drawRightText(page, "Unit (£)", colX[2] + colWidths[2] - colPad, y - 16, bodySize, bold, rgb(1, 1, 1));
    drawRightText(page, "Total (£)", colX[3] + colWidths[3] - colPad, y - 16, bodySize, bold, rgb(1, 1, 1));
    y -= headerH;
  };

  drawTableHeader();

  const items = Array.isArray(order.items)
    ? order.items
    : typeof order.items === "string"
    ? JSON.parse(order.items || "[]")
    : [];

  let subtotal = 0;
  for (const it of items) {
    const qty = numberOrZero(it.qty || 1);
    const unit = numberOrZero(it.unit_price ?? it.price ?? 0);
    const total = qty * unit;
    subtotal += total;

    const descLines = wrapByWidth(String(it.name || "-"), colWidths[0] - colPad * 2, font, bodySize);
    const rowHeight = Math.max(20, descLines.length * 13 + 6);

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
      yy -= 13;
    }

    drawRightText(page, String(qty), colX[1] + colWidths[1] - colPad, y - 14, bodySize, font);
    drawRightText(page, unit.toFixed(2), colX[2] + colWidths[2] - colPad, y - 14, bodySize, font);
    drawRightText(page, total.toFixed(2), colX[3] + colWidths[3] - colPad, y - 14, bodySize, font);

    y -= rowHeight;
  }

  // -----------------------------
  // TOTALS
  // -----------------------------
  const deposit = numberOrZero(order.deposit ?? subtotal * 0.5);
  const balance = numberOrZero(order.balance ?? subtotal - deposit);
  y -= 24;
  const totalsBoxW = 240;
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

  drawText(page, "Project Total:", totalsBoxX + 12, totalsBoxY + 50, bodySize, bold);
  drawRightText(page, `£${subtotal.toFixed(2)}`, totalsBoxX + totalsBoxW - 10, totalsBoxY + 50, bodySize, bold);
  drawText(page, "Deposit Paid:", totalsBoxX + 12, totalsBoxY + 33, bodySize, font);
  drawRightText(page, `£${deposit.toFixed(2)}`, totalsBoxX + totalsBoxW - 10, totalsBoxY + 33, bodySize, font);
  drawText(page, "Balance Due:", totalsBoxX + 12, totalsBoxY + 16, bodySize, font);
  drawRightText(page, `£${balance.toFixed(2)}`, totalsBoxX + totalsBoxW - 10, totalsBoxY + 16, bodySize, font);

  y = totalsBoxY - 26;
  drawText(page, "Thank you for your business!", margin, y, bodySize + 1, bold, BRAND_BLUE);
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
    ["1. Introduction", "By engaging with PJH Web Services, you agree to these Terms governing all services and deliverables."],
    ["2. Customer Agreements", "All work is carried out as agreed in writing. Clients must provide timely and accurate materials and approvals."],
    ["3. Payment Terms", "A deposit (usually 50%) is required before work begins. Remaining payment is due upon completion before launch."],
    ["4. Refund Policy", "Deposits are non-refundable once work has begun. Cancelled projects are billed for work completed."],
    ["5. Intellectual Property", "All designs, code, and content remain PJH Web Services’ property until full payment is received."],
    ["6. Revisions & Changes", "Reasonable revisions are included. Major scope changes may incur additional charges."],
    ["7. Ongoing Support", "Support or maintenance is not included unless specified in a service package."],
    ["8. Limitation of Liability", "We are not liable for downtime, data loss, or third-party issues. Liability is limited to the amount paid."],
    ["9. Termination", "PJH Web Services may terminate services for breach of Terms or non-payment."],
    ["10. Governing Law", "These Terms are governed by the laws of England and Wales."],
  ];

  for (const [title, body] of terms) {
    if (y2 < footerY + 40) {
      drawFooter(termsPage, font);
      const newPage = pdfDoc.addPage(A4);
      y2 = A4[1] - 80;
      newPage.drawRectangle({ x: 0, y: A4[1] - 70, width: A4[0], height: 40, color: BRAND_BLUE });
      drawText(newPage, "Terms & Conditions (continued)", margin, A4[1] - 55, h2, bold, rgb(1, 1, 1));
      drawFooter(newPage, font);
      termsPage = newPage;
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
  // SAVE — includes customer business, invoice number, and project title
  // ---------------------------------------------------------------------------
  const outDir = path.resolve(process.cwd(), "generated", "invoices");
  fs.mkdirSync(outDir, { recursive: true });

  const businessName = sanitizeFilename(order.customer?.business || order.customer?.name || "Customer");
  const projectTitle = sanitizeFilename(order.title || "Project");
  const safeType = typeof invoiceType === "string" ? invoiceType : "deposit";
  const invoiceNumber = order.id ? `INV${String(order.id).padStart(4, "0")}` : "INVXXXX";

  const fileName = `PJH_Web_Services_${businessName}_${projectTitle}_${invoiceNumber}_${safeType.toUpperCase()}.pdf`;
  const outPath = path.join(outDir, fileName);

  fs.writeFileSync(outPath, await pdfDoc.save());
  console.log(`📄 Invoice PDF saved: ${outPath}`);
  return outPath;


  // footer helper
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
