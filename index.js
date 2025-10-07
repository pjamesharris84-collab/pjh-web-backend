// ============================================
// PJH Web Services — Server Startup File
// ============================================

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { runMigrations } from "./db.js";
import { sendEmail } from "./utils/email.js";

// Existing routers
import adminQuotesRoutes from "./routes/adminQuotes.js";
import authRoutes from "./routes/auth.js";
import customerRoutes from "./routes/customers.js";
import orderRoutes from "./routes/orders.js";
import quoteResponseRoutes from "./routes/quoteResponses.js";
import responsesRoutes from "./routes/responses.js";
import orderDiaryRoutes from "./routes/orderDiary.js";
import { quotesCustomerRouter, quotesAdminRouter } from "./routes/quotes.js";

// ✅ New Stripe integrations
import paymentsRouter from "./routes/payments.js";
import stripeWebhook from "./routes/stripeWebhook.js";

dotenv.config();
const app = express();

// -----------------------------------------
// 🌍 Dynamic CORS Configuration
// -----------------------------------------
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

if (!allowedOrigins.includes("http://localhost:5173")) {
  allowedOrigins.push("http://localhost:5173"); // always allow local dev
}

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      console.warn(`🚫 Blocked CORS request from: ${origin}`);
      return callback(new Error("Not allowed by CORS"), false);
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
  })
);

// ✅ Handle preflight requests explicitly
app.options("*", (req, res) => {
  res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization"
  );
  res.header(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS"
  );
  res.header("Access-Control-Allow-Credentials", "true");
  res.sendStatus(200);
});

// -----------------------------------------
// 🧩 Environment Info
// -----------------------------------------
console.log("🧩 Loaded environment:", {
  NODE_ENV: process.env.NODE_ENV,
  PORT: process.env.PORT,
  ALLOWED_ORIGINS: allowedOrigins,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET ? "(set)" : "(missing)",
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY ? "(set)" : "(missing)",
});

// -----------------------------------------
// ⚙️ Middleware (⚠️ Stripe webhook must be raw)
// -----------------------------------------

// ✅ Mount Stripe webhook FIRST (raw body required for signature verification)
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  stripeWebhook
);

// Then normal JSON parsing for everything else
app.use(express.json());

// -----------------------------------------
// 🛠️ Run database migrations
// -----------------------------------------
await runMigrations();

// -----------------------------------------
// ✉️ Contact Form
// -----------------------------------------
app.post("/api/contact", async (req, res) => {
  const { name, email, phone, message } = req.body;
  if (!name || !email || !phone || !message) {
    return res
      .status(400)
      .json({ success: false, error: "All fields required." });
  }

  try {
    await sendEmail({
      from: `"PJH Web Services" <${process.env.SMTP_USER}>`,
      to: process.env.TO_EMAIL || process.env.SMTP_USER,
      subject: `📬 Contact Form: ${name}`,
      text: `${message}\n\nEmail: ${email}\nPhone: ${phone}`,
    });
    res.json({ success: true, message: "Email sent successfully." });
  } catch (error) {
    console.error("❌ Contact form failed:", error);
    res.status(500).json({ success: false, error: "Failed to send email." });
  }
});

// -----------------------------------------
// 📦 API Routes
// -----------------------------------------

// ✅ New Stripe payments routes
app.use("/api/payments", paymentsRouter);

app.use("/api/admin/quotes", adminQuotesRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/quotes", quoteResponseRoutes);
app.use("/api/responses", responsesRoutes);
app.use("/api/orders", orderDiaryRoutes);

// Dual mount quotes
app.use("/api/customers", quotesCustomerRouter);
app.use("/api/quotes", quotesAdminRouter);

// -----------------------------------------
// 🌐 Root Health Check
// -----------------------------------------
app.get("/", (req, res) => {
  res.send("✅ PJH Web Services API running with Stripe integration");
});

// -----------------------------------------
// 🚀 Server Start
// -----------------------------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Backend live at: http://localhost:${PORT}`);
});
