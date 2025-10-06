// ============================================
// PJH Web Services — Server Startup File
// ============================================

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { runMigrations } from "./db.js";

dotenv.config();

console.log("🧩 Environment check:");
["ADMIN_PASS", "SMTP_HOST", "SMTP_USER", "TO_EMAIL"].forEach(k =>
  console.log(`${k}:`, process.env[k] ? "(set)" : "(missing)")
);


const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// ============================================
// Run database migrations on startup
// ============================================
await runMigrations();

// ============================================
// Base test route
// ============================================
app.get("/", (req, res) => {
  res.send("✅ PJH Web Services API is running successfully.");
});

// ============================================
// Start the server
// ============================================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
