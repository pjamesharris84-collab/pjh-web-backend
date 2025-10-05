import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { runMigrations } from "./db.js";
import { sendEmail } from "./utils/email.js";

// ✅ Modular route imports
import contactRoutes from "./routes/contact.js";
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
app.use(cors());
app.use(express.json());

// 🧩 Environment summary
console.log("🧩 Environment loaded:", {
  PORT: process.env.PORT,
  PG_DB: process.env.PG_DB,
  ADMIN_PASS: process.env.ADMIN_PASS ? "(set)" : "(missing)",
});

// Run migrations before accepting requests
await runMigrations();

// -----------------------------
// ✉️ Contact Form
// -----------------------------
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
    res.json({ success: true, message: "Email sent successfully." });
  } catch (e) {
    console.error("❌ Contact form email failed:", e);
    res.status(500).json({ success: false, error: "Failed to send email." });
  }
});

// -----------------------------
// 📦 API Routes
// -----------------------------
app.use("/api/contact", contactRoutes);
app.use("/api/admin/quotes", adminQuotesRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/orders", orderRoutes);

// ✅ Quotes routes (dual mount)
app.use("/api/customers", quotesCustomerRouter); // /api/customers/:id/quotes
app.use("/api/quotes", quotesAdminRouter);       // /api/quotes/:quoteId etc.

// ✅ Additional modules
app.use("/api/quotes", quoteResponseRoutes);
app.use("/api/responses", responsesRoutes);
app.use("/api/orders", orderDiaryRoutes); // backward compatibility

// -----------------------------
// 🌐 Root Endpoint
// -----------------------------
app.get("/", (req, res) => {
  res.send("✅ PJH Web Services API running successfully");
});

// -----------------------------
// 🚀 Start Server
// -----------------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () =>
  console.log(`🚀 Server running on http://localhost:${PORT}`)
);
