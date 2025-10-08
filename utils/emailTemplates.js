// ============================================
// PJH Web Services — HTML Email Templates
// ============================================
//
// Includes Base64-embedded logo (from emailLogo.js) so
// branding always appears in emails even when remote
// images are blocked.
//
import { LOGO_BASE64 } from "./emailLogo.js";

/* ============================================================
   💳 PAYMENT REQUEST
============================================================ */
export function paymentRequestTemplate({
  customerName,
  orderTitle,
  amount,
  link,
  type,
}) {
  return `
  <html>
    <body style="font-family:'Segoe UI',Helvetica,Arial,sans-serif;background-color:#f4f6f8;padding:40px;margin:0;">
      <table width="100%" cellpadding="0" cellspacing="0" 
             style="max-width:600px;margin:auto;background:#ffffff;border-radius:12px;
                    box-shadow:0 4px 15px rgba(0,0,0,0.08);overflow:hidden;">
        
        <!-- Header -->
        <tr>
          <td style="background:#0d1117;text-align:center;padding:25px;">
            <img src="${LOGO_BASE64}" alt="PJH Web Services" width="140" style="max-width:140px;height:auto;margin:auto;display:block;">
            <h2 style="color:#58a6ff;margin:15px 0 0;font-size:22px;">
              Secure ${type} Payment Link
            </h2>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:35px 40px;">
            <p style="color:#333;font-size:16px;">Hi ${customerName || "Customer"},</p>
            <p style="color:#333;line-height:1.6;font-size:15px;">
              You can complete your <strong>${type}</strong> payment of
              <strong>£${amount.toFixed(2)}</strong> for your order
              <strong>${orderTitle}</strong> using the secure link below.
            </p>

            <div style="text-align:center;margin:35px 0;">
              <a href="${link}" 
                 style="background:#007bff;color:#fff;text-decoration:none;font-weight:600;
                        padding:14px 28px;border-radius:8px;display:inline-block;font-size:16px;">
                💳 Pay Now
              </a>
            </div>

            <p style="color:#555;font-size:14px;line-height:1.5;">
              Once payment is received, your order balance will update automatically
              and you’ll receive a detailed receipt via email.
            </p>

            <p style="color:#777;font-size:13px;margin-top:30px;line-height:1.5;">
              Kind regards,<br><strong>PJH Web Services</strong><br>
              <a href="https://www.pjhwebservices.co.uk" 
                 style="color:#007bff;text-decoration:none;">www.pjhwebservices.co.uk</a>
            </p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#0d1117;color:#999;text-align:center;font-size:12px;padding:12px;">
            © ${new Date().getFullYear()} PJH Web Services — All Rights Reserved
          </td>
        </tr>
      </table>
    </body>
  </html>`;
}

/* ============================================================
   🧾 INVOICE
============================================================ */
export function invoiceEmailTemplate({
  customerName,
  orderTitle,
  invoiceType,
  amount,
  link,
}) {
  return `
  <html>
    <body style="font-family:'Segoe UI',Helvetica,Arial,sans-serif;background-color:#f4f6f8;padding:40px;margin:0;">
      <table width="100%" cellpadding="0" cellspacing="0" 
             style="max-width:600px;margin:auto;background:#ffffff;border-radius:12px;
                    box-shadow:0 4px 15px rgba(0,0,0,0.08);overflow:hidden;">
        <tr>
          <td style="background:#0d1117;text-align:center;padding:25px;">
            <img src="${LOGO_BASE64}" alt="PJH Web Services" width="130" style="max-width:130px;height:auto;margin:auto;display:block;">
            <h2 style="color:#58a6ff;margin:15px 0 0;font-size:22px;">
              ${invoiceType.charAt(0).toUpperCase() + invoiceType.slice(1)} Invoice
            </h2>
          </td>
        </tr>
        <tr>
          <td style="padding:35px 40px;">
            <p style="color:#333;font-size:16px;">Hi ${customerName || "Customer"},</p>
            <p style="color:#333;line-height:1.6;font-size:15px;">
              Please find attached your <strong>${invoiceType}</strong> invoice for
              <strong>${orderTitle}</strong>. The total due is <strong>£${amount.toFixed(2)}</strong>.
            </p>

            ${
              link
                ? `<div style="text-align:center;margin:35px 0;">
                    <a href="${link}"
                       style="background:#007bff;color:#fff;text-decoration:none;font-weight:600;
                              padding:14px 28px;border-radius:8px;display:inline-block;font-size:16px;">
                      💳 Pay Invoice
                    </a>
                   </div>`
                : ""
            }

            <p style="color:#555;font-size:14px;line-height:1.5;">
              Once payment is received, you’ll automatically receive a receipt and your
              project record will update accordingly.
            </p>

            <p style="color:#777;font-size:13px;margin-top:30px;line-height:1.5;">
              Kind regards,<br><strong>PJH Web Services</strong><br>
              <a href="https://www.pjhwebservices.co.uk" style="color:#007bff;text-decoration:none;">www.pjhwebservices.co.uk</a>
            </p>
          </td>
        </tr>
        <tr>
          <td style="background:#0d1117;color:#999;text-align:center;font-size:12px;padding:12px;">
            © ${new Date().getFullYear()} PJH Web Services — All Rights Reserved
          </td>
        </tr>
      </table>
    </body>
  </html>`;
}

/* ============================================================
   ✅ PAYMENT SUCCESS
============================================================ */
export function paymentSuccessTemplate({ customerName, amount }) {
  return `
  <html>
    <body style="font-family:'Segoe UI',Helvetica,Arial,sans-serif;background:#f4f6f8;padding:40px;margin:0;">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:auto;background:#fff;border-radius:12px;box-shadow:0 4px 15px rgba(0,0,0,0.08);">
        <tr>
          <td style="background:#0d1117;text-align:center;padding:25px;">
            <img src="${LOGO_BASE64}" alt="PJH Web Services" width="130" style="display:block;margin:auto;">
            <h2 style="color:#4caf50;margin:15px 0 0;">Payment Received</h2>
          </td>
        </tr>
        <tr>
          <td style="padding:35px 40px;">
            <p style="font-size:16px;color:#333;">Hi ${customerName || "Customer"},</p>
            <p style="color:#333;line-height:1.6;font-size:15px;">
              We’ve successfully received your payment of <strong>£${amount.toFixed(2)}</strong>.
              Your account has been updated and your project will continue as planned.
            </p>
            <p style="color:#555;font-size:14px;line-height:1.5;">
              Thank you for your prompt payment and trust in PJH Web Services.
            </p>
            <p style="color:#777;font-size:13px;margin-top:30px;">
              Kind regards,<br><strong>PJH Web Services</strong>
            </p>
          </td>
        </tr>
        <tr>
          <td style="background:#0d1117;color:#999;text-align:center;font-size:12px;padding:12px;">
            © ${new Date().getFullYear()} PJH Web Services
          </td>
        </tr>
      </table>
    </body>
  </html>`;
}

/* ============================================================
   ⚠️ PAYMENT FAILURE
============================================================ */
export function paymentFailureTemplate({ customerName, amount }) {
  return `
  <html>
    <body style="font-family:'Segoe UI',Helvetica,Arial,sans-serif;background:#f4f6f8;padding:40px;margin:0;">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:auto;background:#fff;border-radius:12px;box-shadow:0 4px 15px rgba(0,0,0,0.08);">
        <tr>
          <td style="background:#0d1117;text-align:center;padding:25px;">
            <img src="${LOGO_BASE64}" alt="PJH Web Services" width="130" style="display:block;margin:auto;">
            <h2 style="color:#e74c3c;margin:15px 0 0;">Payment Failed</h2>
          </td>
        </tr>
        <tr>
          <td style="padding:35px 40px;">
            <p style="font-size:16px;color:#333;">Hi ${customerName || "Customer"},</p>
            <p style="color:#333;line-height:1.6;font-size:15px;">
              Unfortunately, your recent payment of <strong>£${amount.toFixed(2)}</strong> did not go through.
              Please check your payment method or try again via the link provided by our team.
            </p>
            <p style="color:#555;font-size:14px;line-height:1.5;">
              If you continue to experience issues, contact us at 
              <a href="mailto:info@pjhwebservices.co.uk" style="color:#007bff;">info@pjhwebservices.co.uk</a>.
            </p>
            <p style="color:#777;font-size:13px;margin-top:30px;">
              Kind regards,<br><strong>PJH Web Services</strong>
            </p>
          </td>
        </tr>
        <tr>
          <td style="background:#0d1117;color:#999;text-align:center;font-size:12px;padding:12px;">
            © ${new Date().getFullYear()} PJH Web Services
          </td>
        </tr>
      </table>
    </body>
  </html>`;
}

/* ============================================================
   🧾 DIRECT DEBIT SETUP CONFIRMATION
============================================================ */
export function directDebitSetupTemplate({ customerName }) {
  return `
  <html>
    <body style="font-family:'Segoe UI',Helvetica,Arial,sans-serif;background:#f4f6f8;padding:40px;margin:0;">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:auto;background:#fff;border-radius:12px;box-shadow:0 4px 15px rgba(0,0,0,0.08);">
        <tr>
          <td style="background:#0d1117;text-align:center;padding:25px;">
            <img src="${LOGO_BASE64}" alt="PJH Web Services" width="130" style="display:block;margin:auto;">
            <h2 style="color:#58a6ff;margin:15px 0 0;">Direct Debit Mandate Confirmed</h2>
          </td>
        </tr>
        <tr>
          <td style="padding:35px 40px;">
            <p style="font-size:16px;color:#333;">Hi ${customerName || "Customer"},</p>
            <p style="color:#333;line-height:1.6;font-size:15px;">
              Your Direct Debit mandate has been successfully set up.
              Payments will now be collected automatically as per your chosen plan.
            </p>
            <p style="color:#555;font-size:14px;">
              You’ll receive email notices before each collection and can cancel your
              Direct Debit at any time via your bank.
            </p>
            <p style="color:#777;font-size:13px;margin-top:30px;">
              Kind regards,<br><strong>PJH Web Services</strong>
            </p>
          </td>
        </tr>
        <tr>
          <td style="background:#0d1117;color:#999;text-align:center;font-size:12px;padding:12px;">
            © ${new Date().getFullYear()} PJH Web Services
          </td>
        </tr>
      </table>
    </body>
  </html>`;
}
