// ============================================================
// PJH Web Services — Server Startup File (Unified Billing Ready)
// ============================================================
// Handles:
//  ✅ Express core + database migrations
//  ✅ Secure CORS for local, Vercel, and live
//  ✅ Stripe webhook signature-safe handling (Render-compatible)
//  ✅ Static file delivery for PDFs/logos
//  ✅ Email-powered contact form
// ============================================================

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import { runMigrations } from "./db.js";
import { sendEmail } from "./utils/email.js";

// Routers
import adminQuotesRoutes from "./routes/adminQuotes.js";
import authRoutes from "./routes/auth.js";
import customerRoutes from "./routes/customers.js";
import orderRoutes from "./routes/orders.js";
import quoteResponseRoutes from "./routes/quoteResponses.js";
import responsesRoutes from "./routes/responses.js";
import orderDiaryRoutes from "./routes/orderDiary.js";
import { quotesCustomerRouter, quotesAdminRouter } from "./routes/quotes.js";
import packagesRouter from "./routes/packages.js";
import maintenanceRouter from "./routes/maintenance.js";

// ✅ Unified Stripe Checkout + Direct Debit Billing
import paymentsRouter from "./routes/payments.js";

import path from "path";
import { fileURLToPath } from "url";

dotenv.config();
const app = express();

/* ============================================================
   ⚡ Stripe Webhook — Must be RAW, mounted BEFORE express.json()
============================================================ */
app.post(
  "/api/payments/webhook",
  bodyParser.raw({ type: "application/json" }),
  (req, res, next) => {
    // Pass through to router — Stripe will verify raw body inside
    next();
  }
);

/* ============================================================
   🌍 CORS Configuration (Local + Live + Vercel)
============================================================ */
const defaultOrigins = [
  "http://localhost:5173",
  "https://pjhwebservices.co.uk",
  "https://www.pjhwebservices.co.uk",
  "https://pjh-web-frontend.vercel.app",
  "https://pjh-web-frontend-dh9sx9tba-pj-harris-projects.vercel.app",
];

const allowedOrigins = (
  process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
    : []
)
  .filter(Boolean)
  .concat(defaultOrigins.filter((o) => !process.env.ALLOWED_ORIGINS?.includes(o)));

app.use(
  cors({
    origin: (origin, callback) => {
      if (
        !origin ||
        allowedOrigins.includes(origin) ||
        /\.vercel\.app$/.test(origin)
      ) {
        return callback(null, true);
      }
      console.warn(`🚫 Blocked CORS: ${origin}`);
      return callback(new Error("Not allowed by CORS"), false);
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
  })
);

app.options("*", (req, res) => {
  res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization"
  );
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Credentials", "true");
  res.sendStatus(200);
});

/* ============================================================
   🧠 Environment Summary
============================================================ */
console.log("🧩 Environment loaded:");
console.table({
  NODE_ENV: process.env.NODE_ENV,
  PORT: process.env.PORT,
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY ? "✅" : "❌",
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET ? "✅" : "❌",
  DATABASE_URL: process.env.DATABASE_URL ? "✅" : "❌",
  FRONTEND_URL:
    process.env.FRONTEND_URL || "https://www.pjhwebservices.co.uk",
});

/* ============================================================
   🧱 Enable JSON Parsing (after webhook route)
============================================================ */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ============================================================
   🧱 Database Migrations
============================================================ */
await runMigrations();

/* ============================================================
   ✉️ Contact Form Handler
============================================================ */
app.post("/api/contact", async (req, res) => {
  const { name, email, phone, message } = req.body;

  if (!name || !email || !phone || !message) {
    return res
      .status(400)
      .json({ success: false, error: "All fields are required." });
  }

  try {
    await sendEmail({
      from: `"PJH Web Services" <${process.env.SMTP_USER}>`,
      to: process.env.TO_EMAIL || process.env.SMTP_USER,
      subject: `📬 Contact Form: ${name}`,
      text: `${message}\n\nEmail: ${email}\nPhone: ${phone}`,
    });

    console.log(`📧 Contact form received from ${name} (${email})`);
    res.json({ success: true, message: "Email sent successfully." });
  } catch (err) {
    console.error("❌ Contact form error:", err.message);
    res.status(500).json({ success: false, error: "Failed to send email." });
  }
});

/* ============================================================
   📦 API Routes
============================================================ */
// ✅ Unified Stripe Billing System
app.use("/api/payments", paymentsRouter);

// ✅ Core Routers
app.use("/api/admin/quotes", adminQuotesRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/quotes", quoteResponseRoutes);
app.use("/api/responses", responsesRoutes);
app.use("/api/packages", packagesRouter);
app.use("/api/maintenance", maintenanceRouter);

// ✅ Dedicated Order Diary
app.use("/api/diary", orderDiaryRoutes);

// ✅ Dual-Mount Quotes (Customer/Admin)
app.use("/api/customers", quotesCustomerRouter);
app.use("/api/quotes", quotesAdminRouter);

/* ============================================================
   🩹 Stub for /api/payments/schedule/:id
============================================================ */
app.get("/api/payments/schedule/:id", (req, res) => {
  res.json({
    success: true,
    schedule: [],
    message: "No recurring schedule available for this order yet.",
  });
});

/* ============================================================
   🖼️ Static File Serving (PDFs, logos, etc.)
============================================================ */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicPath = path.join(__dirname, "public");
app.use(express.static(publicPath));

/* ============================================================
   🌐 Health Check Endpoint
============================================================ */
app.get("/", (req, res) => {
  res.send(
    "✅ PJH Web Services API — Unified Stripe Checkout + Recurring Billing Active."
  );
});

/* ============================================================
   🚀 Server Startup
============================================================ */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Backend running on port: ${PORT}`);
  console.log("🌍 Allowed Origins:");
  allowedOrigins.forEach((o) => console.log("   •", o));
});
