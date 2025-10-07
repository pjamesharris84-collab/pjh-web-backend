// ============================================
// PJH Web Services — HTML Email Templates
// ============================================
//
// Includes Base64-embedded logo (from emailLogo.js) so
// branding always appears in emails even when remote
// images are blocked.
//

import { LOGO_BASE64 } from "./emailLogo.js";

/**
 * Styled HTML payment request email
 * @param {Object} data
 * @param {string} data.customerName
 * @param {string} data.orderTitle
 * @param {number} data.amount
 * @param {string} data.link
 * @param {"deposit"|"balance"} data.type
 */
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
            <img 
              src="${LOGO_BASE64}" 
              alt="PJH Web Services" 
              width="140" height="auto"
              style="display:block;margin:auto;max-width:140px;height:auto;">
            <h2 style="color:#58a6ff;margin:15px 0 0;font-size:22px;">
              Secure ${type} Payment Link
            </h2>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:35px 40px;">
            <p style="color:#333333;font-size:16px;">Hi ${customerName || "Customer"},</p>
            <p style="color:#333333;line-height:1.6;font-size:15px;">
              You can complete your <strong>${type}</strong> payment of
              <strong>£${amount.toFixed(2)}</strong> for your order
              <strong>${orderTitle}</strong> using the secure link below.
            </p>

            <div style="text-align:center;margin:35px 0;">
              <a href="${link}" 
                 style="background:#007bff;color:#ffffff;text-decoration:none;font-weight:600;
                        padding:14px 28px;border-radius:8px;display:inline-block;font-size:16px;">
                💳 Pay Now
              </a>
            </div>

            <p style="color:#555555;font-size:14px;line-height:1.5;">
              Once payment is received, your order balance will update automatically
              and you’ll receive a detailed receipt via email.
            </p>

            <p style="color:#777777;font-size:13px;margin-top:30px;line-height:1.5;">
              Kind regards,<br>
              <strong>PJH Web Services</strong><br>
              <a href="https://www.pjhwebservices.co.uk" 
                 style="color:#007bff;text-decoration:none;">www.pjhwebservices.co.uk</a>
            </p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#0d1117;color:#999999;text-align:center;font-size:12px;padding:12px;">
            © ${new Date().getFullYear()} PJH Web Services — All Rights Reserved
          </td>
        </tr>
      </table>
    </body>
  </html>
  `;
}
