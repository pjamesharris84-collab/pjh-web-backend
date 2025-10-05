/**
 * ============================================================
 * PJH Web Services — Simple Admin Authentication
 * ============================================================
 * Provides minimal login protection for the admin dashboard.
 * Uses a password stored in .env (ADMIN_PASS) for access.
 * ============================================================
 */

import express from "express";
import dotenv from "dotenv";

dotenv.config();
const router = express.Router();

/**
 * @route   POST /api/auth/login
 * @desc    Basic admin login check
 * @access  Private (simple password)
 */
router.post("/login", (req, res) => {
  const { password } = req.body;
  const adminPass = process.env.ADMIN_PASS || "changeme";

  // Validate password presence
  if (!password) {
    return res
      .status(400)
      .json({ success: false, message: "Password is required." });
  }

  // Compare
  if (password === adminPass) {
    console.log("✅ Admin login successful");
    return res.json({ success: true, message: "Login successful." });
  }

  console.warn("❌ Invalid admin login attempt");
  return res
    .status(401)
    .json({ success: false, message: "Invalid password." });
});

export default router;
