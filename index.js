// ============================================================
// PJH Web Services — Server Startup File
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
import paymentsRouter from "./routes/payments.js";

dotenv.config();
const app = express();

/* ============================================================
   🌍 CORS
============================================================ */
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
if (!allowedOrigins.includes("http://localhost:5173")) allowedOrigins.push("http://localhost:5173");

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      console.warn(`🚫 Blocked CORS: ${origin}`);
      return cb(new Error("CORS blocked"), false);
    },
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
   🧠 Environment Info
============================================================ */
console.log("🧩 Environment loaded:");
console.table({
  NODE_ENV: process.env.NODE_ENV,
  PORT: process.env.PORT,
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY ? "✅" : "❌",
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET ? "✅" : "❌",
});

/* ============================================================
   ⚙️ Middleware
============================================================ */

// Stripe webhook (must use raw body)
app.use("/api/payments/webhook", express.raw({ type: "application/json" }), paymentsRouter);

// All other routes use JSON
app.use(express.json());

/* ============================================================
   🧱 Migrations
============================================================ */
await runMigrations();

/* ============================================================
   ✉️ Contact Form
============================================================ */
app.post("/api/contact", async (req, res) => {
  const { name, email, phone, message } = req.body;
  if (!name || !email || !phone || !message)
    return res.status(400).json({ success: false, error: "All fields required." });

  try {
    await sendEmail({
      from: `"PJH Web Services" <${process.env.SMTP_USER}>`,
      to: process.env.TO_EMAIL || process.env.SMTP_USER,
      subject: `📬 Contact Form: ${name}`,
      text: `${message}\n\nEmail: ${email}\nPhone: ${phone}`,
    });
    console.log(`📧 Contact received from ${name} (${email})`);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Contact form failed:", err.message);
    res.status(500).json({ success: false, error: "Email failed." });
  }
});

/* ============================================================
   📦 API Routes
============================================================ */
app.use("/api/payments", paymentsRouter);
app.use("/api/admin/quotes", adminQuotesRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/quotes", quoteResponseRoutes);
app.use("/api/responses", responsesRoutes);
app.use("/api/orders", orderDiaryRoutes);
app.use("/api/packages", packagesRouter);
app.use("/api/customers", quotesCustomerRouter);
app.use("/api/quotes", quotesAdminRouter);

app.use(express.static("public"));

/* ============================================================
   🌐 Health Check
============================================================ */
app.get("/", (req, res) =>
  res.send("✅ PJH Web Services API — Stripe Checkout + Recurring Billing Active.")
);

/* ============================================================
   🚀 Start Server
============================================================ */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Backend running on port ${PORT}`));
