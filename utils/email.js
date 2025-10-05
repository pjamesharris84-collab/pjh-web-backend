// server/utils/email.js
import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

/* =======================================================
   IONOS SMTP Transporter (STARTTLS on Port 587)
   ======================================================= */
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.ionos.co.uk",
  port: process.env.SMTP_PORT || 587,
  secure: false, // STARTTLS, not SSL
  requireTLS: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: {
    // Allow IONOS’s self-signed certs in the chain
    rejectUnauthorized: false,
  },
});

/* -------------------------------------------------------
   Verify SMTP connection once at startup
   ------------------------------------------------------- */
transporter.verify((err, success) => {
  if (err) {
    console.error("❌ SMTP connection failed:", err.message);
  } else {
    console.log("✅ SMTP server ready to send emails");
  }
});

/* =======================================================
   Send Email Helper Function
   ======================================================= */
export async function sendEmail({ to, subject, html, text, attachments }) {
  try {
    const finalRecipient = process.env.TEST_EMAIL || to;

    const info = await transporter.sendMail({
      from: `"PJH Web Services" <${process.env.SMTP_USER}>`,
      to: finalRecipient,
      subject,
      text,
      html,
      attachments,
    });

    console.log(`📧 Email sent to ${finalRecipient}: ${info.messageId}`);
    return info;
  } catch (err) {
    console.error("❌ Error sending email:", err.message);
    throw err;
  }
}
