// ============================================================
// PJH Web Services — Server Startup File (Unified Billing Ready)
// ============================================================

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
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

// ✅ Unified Stripe Checkout + Direct Debit Billing
import paymentsRouter, { paymentsWebhook } from "./routes/payments.js";

dotenv.config();
const app = express();

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
      // ✅ Allow localhost, live domains, and any .vercel.app preview
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

// ✅ Handle preflight (OPTIONS) requests
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
   ⚙️ Stripe Webhook (must run BEFORE express.json)
============================================================ */
app.post(
  "/api/payments/webhook",
  express.raw({ type: "application/json" }),
  paymentsWebhook
);

// All other routes use normal JSON parsing
app.use(express.json());

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

// ✅ Dedicated Order Diary
app.use("/api/diary", orderDiaryRoutes);

// ✅ Dual-Mount Quotes (Customer/Admin)
app.use("/api/customers", quotesCustomerRouter);
app.use("/api/quotes", quotesAdminRouter);

/* ============================================================
   🩹 Stub for /api/payments/schedule/:id
   (prevents 404s until recurring billing logic added)
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
app.use(express.static("public"));

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
