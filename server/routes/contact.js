// ============================================
// PJH Web Services — Contact Form Route
// ============================================

import express from "express";
import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();
const router = express.Router();

// ============================================
// Create a reusable IONOS SMTP transporter
// ============================================
const transporter = nodemailer.createTransport({
  host: "smtp.ionos.co.uk",
  port: 587, // ✅ STARTTLS port
  secure: false, // STARTTLS, not SSL
  requireTLS: true, // Force upgrade to TLS
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: {
    rejectUnauthorized: false, // Allow IONOS self-signed certs
  },
});

// Verify SMTP connection at startup
transporter.verify((err, success) => {
  if (err) {
    console.error("❌ SMTP connection failed:", err.message);
  } else {
    console.log("✅ SMTP server ready to send emails");
  }
});

// ============================================
// POST /api/contact
// ============================================
router.post("/", async (req, res) => {
  const { name, email, phone, message } = req.body;

  // -----------------------------
  // Basic validation
  // -----------------------------
  if (!name || !email || !phone || !message) {
    return res
      .status(400)
      .json({ success: false, error: "All fields (name, email, phone, message) are required." });
  }

  // -----------------------------
  // Build the email
  // -----------------------------
  const mailOptions = {
    from: `"PJH Web Services Contact Form" <${process.env.SMTP_USER}>`,
    to: process.env.TO_EMAIL || process.env.SMTP_USER,
    replyTo: email,
    subject: `📬 New Contact Form Submission from ${name}`,
    text: `
You have received a new contact form submission from your website.

Name: ${name}
Email: ${email}
Phone: ${phone}

Message:
${message}

---
Sent automatically from the PJH Web Services website contact form.
`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 640px; margin:auto; color:#111;">
        <h2 style="color:#2563eb;">New Contact Form Submission</h2>
        <p>You have received a new message from your website:</p>

        <table style="border-collapse: collapse; width: 100%; margin-top: 10px;">
          <tr><td style="padding: 8px; font-weight: bold;">Name:</td><td>${name}</td></tr>
          <tr><td style="padding: 8px; font-weight: bold;">Email:</td><td>${email}</td></tr>
          <tr><td style="padding: 8px; font-weight: bold;">Phone:</td><td>${phone}</td></tr>
          <tr><td style="padding: 8px; font-weight: bold; vertical-align: top;">Message:</td>
              <td>${message.replace(/\n/g, "<br>")}</td></tr>
        </table>

        <p style="margin-top: 20px; font-size: 13px; color: #6b7280;">
          — This message was sent automatically from the <strong>PJH Web Services</strong> website contact form.
        </p>
      </div>
    `,
  };

  // -----------------------------
  // Send the email
  // -----------------------------
  try {
    await transporter.sendMail(mailOptions);
    console.log(`📧 Contact form email sent successfully from ${name} <${email}>`);
    res.status(200).json({ success: true, message: "Email sent successfully." });
  } catch (error) {
    console.error("❌ Email send error:", error.message);
    res.status(500).json({ success: false, error: "Email failed to send." });
  }
});

export default router;
