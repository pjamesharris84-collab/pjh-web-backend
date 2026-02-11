import "dotenv/config";
import nodemailer from "nodemailer";

console.log("SMTP_USER:", process.env.SMTP_USER);
console.log("SMTP_PASS set:", !!process.env.SMTP_PASS);

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.ionos.co.uk",
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,          // correct for 587
  requireTLS: true,       // recommended for 587
  auth: {
    user: process.env.SMTP_USER,  // full mailbox email
    pass: process.env.SMTP_PASS,
  },
});

(async () => {
  try {
    await transporter.verify();
    console.log("SMTP OK");
  } catch (err) {
    console.error("SMTP FAIL:", err?.response || err?.message || err);
  }
})();
