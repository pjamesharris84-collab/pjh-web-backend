// ============================================
// PJH Web Services — HTML Email Templates
// ============================================

/**
 * Styled HTML payment request email
 * @param {Object} data
 * @param {string} data.customerName
 * @param {string} data.orderTitle
 * @param {number} data.amount
 * @param {string} data.link
 * @param {"deposit"|"balance"} data.type
 */
export function paymentRequestTemplate({ customerName, orderTitle, amount, link, type }) {
  return `
  <html>
    <body style="font-family:'Segoe UI',Helvetica,Arial,sans-serif;background-color:#f4f6f8;padding:40px;">
      <table width="100%" style="max-width:600px;margin:auto;background:#fff;border-radius:12px;box-shadow:0 4px 15px rgba(0,0,0,0.05);overflow:hidden;">
        <tr>
          <td style="background:#0d1117;text-align:center;padding:20px;">
            <img src="https://pjh-web-backend-1.onrender.com/pjh-logo-dark.png" alt="PJH Web Services" style="height:60px;">
            <h2 style="color:#58a6ff;margin:10px 0 0;">Secure ${type} Payment Link</h2>
          </td>;
        </tr>
        <tr>
          <td style="padding:30px;">
            <p style="color:#333;">Hi ${customerName || "Customer"},</p>
            <p style="color:#333;line-height:1.6;">
              You can complete your <strong>${type}</strong> payment of
              <strong>£${amount.toFixed(2)}</strong> for your order
              <strong>${orderTitle}</strong> using the secure link below.
            </p>

            <div style="text-align:center;margin:30px 0;">
              <a href="${link}" style="display:inline-block;background:#007bff;color:#fff;text-decoration:none;font-weight:600;padding:14px 28px;border-radius:8px;">
                💳 Pay Now
              </a>
            </div>

            <p style="color:#666;font-size:14px;line-height:1.5;">
              Once payment is received, your order balance will update automatically
              and you’ll receive a receipt via email.
            </p>

            <p style="color:#777;font-size:13px;margin-top:30px;">
              Kind regards,<br>
              <strong>PJH Web Services</strong><br>
              <a href="https://www.pjhwebservices.co.uk" style="color:#007bff;">www.pjhwebservices.co.uk</a>
            </p>
          </td>
        </tr>
        <tr>
          <td style="background:#0d1117;color:#999;text-align:center;font-size:12px;padding:10px;">
            © ${new Date().getFullYear()} PJH Web Services — All Rights Reserved
          </td>
        </tr>
      </table>
    </body>
  </html>
  `;
}
