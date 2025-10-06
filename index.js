import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { runMigrations } from "./db.js";
import { sendEmail } from "./utils/email.js";

// ✅ Modular route imports
import adminQuotesRoutes from "./routes/adminQuotes.js";
import authRoutes from "./routes/auth.js";
import customerRoutes from "./routes/customers.js";
import orderRoutes from "./routes/orders.js";
import quoteResponseRoutes from "./routes/quoteResponses.js";
import responsesRoutes from "./routes/responses.js";
import orderDiaryRoutes from "./routes/orderDiary.js";
import { quotesCustomerRouter, quotesAdminRouter } from "./routes/quotes.js";

dotenv.config();
const app = express();

// -----------------------------------------
// 🌍 CORS Configuration
// -----------------------------------------
const allowedOrigins = [
  "http://localhost:5173", // local dev
  "https://pjh-web-frontend.vercel.app", // default Vercel deployment
  "https://pjh-web-frontend-git-main-pj-harris-projects.vercel.app", // preview branch
  "https://www.pjhwebservices.co.uk", // custom domain
];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow no-origin requests (like Postman, server-side)
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      } else {
        console.warn(`❌ Blocked CORS request from: ${origin}`);
        return callback(new Error("Not allowed by CORS"), false);
      }
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
  })
);

// ✅ Add standard security headers
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Credentials", "true");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization"
  );
  res.header(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS"
  );
  next();
});

// -----------------------------------------
// 🔧 Core Middleware
// -----------------------------------------
app.use(express.json());

// -----------------------------------------
// 🧩 Environment Summary
// -----------------------------------------
console.log("🧩 Environment loaded:", {
  NODE_ENV: process.env.NODE_ENV,
  PORT: process.env.PORT,
  DB: process.env.PG_DB,
  ADMIN_PASS: process.env.ADMIN_PASS ? "(set)" : "(missing)",
});

// -----------------------------------------
// 🛠️ Run Migrations Before Serving Requests
// -----------------------------------------
await runMigrations();

// -----------------------------------------
// ✉️ Contact Form Route
// -----------------------------------------
app.post("/api/contact", async (req, res) => {
  const { name, email, phone, message } = req.body;

  if (!name || !email || !phone || !message) {
    return res.status(400).json({
      success: false,
      error: "All fields are required.",
    });
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
    console.error("❌ Contact form email failed:", error);
    res.status(500).json({
      success: false,
      error: "Failed to send email. Please try again later.",
    });
  }
});

// -----------------------------------------
// 📦 API Routes
// -----------------------------------------
app.use("/api/admin/quotes", adminQuotesRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/quotes", quoteResponseRoutes);
app.use("/api/responses", responsesRoutes);
app.use("/api/orders", orderDiaryRoutes);

// ✅ Dual mount quotes routes
app.use("/api/customers", quotesCustomerRouter);
app.use("/api/quotes", quotesAdminRouter);

// -----------------------------------------
// 🌐 Root Endpoint
// -----------------------------------------
app.get("/", (req, res) => {
  res.send("✅ PJH Web Services API is running successfully on Render.");
});

// -----------------------------------------
// 🚀 Start Server
// -----------------------------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server live at: http://localhost:${PORT}`);
});
