// ============================================
// PJH Web Services — Stripe Payment Session Routes
// ============================================

import express from "express";
import Stripe from "stripe";
import dotenv from "dotenv";
import pool from "../db.js";
import { sendEmail } from "../utils/email.js";
import { paymentRequestTemplate } from "../utils/emailTemplates.js";

dotenv.config();

const router = express.Router();

// ✅ Stripe client setup (auto API version from key)
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ✅ Fallback for local vs production frontends
const FRONTEND_URL =
  process.env.FRONTEND_URL ||
  (process.env.NODE_ENV === "development"
    ? "http://localhost:5173"
    : "https://www.pjhwebservices.co.uk");

/**
 * ============================================
 * POST /api/payments/create-session
 * Create a Stripe Checkout session for deposit or balance
 * ============================================
 */
router.post("/create-session", async (req, res) => {
  const { orderId, type } = req.body;

  // ⚠️ Validate incoming data
  if (!orderId || !["deposit", "balance"].includes(type)) {
    return res
      .status(400)
      .json({ success: false, error: "Invalid orderId or payment type" });
  }

  try {
    // 🔍 Fetch order and customer info
    const { rows } = await pool.query(
      `
      SELECT o.*, c.name, c.email, c.business
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      WHERE o.id = $1;
      `,
      [orderId]
    );

    if (rows.length === 0)
      return res.status(404).json({ success: false, error: "Order not found" });

    const order = rows[0];
    const amount = type === "deposit" ? Number(order.deposit) : Number(order.balance);

    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        error: `No outstanding ${type} amount for this order.`,
      });
    }

    // 💳 Create Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "gbp",
            product_data: {
              name: `${type === "deposit" ? "Deposit" : "Balance"} — ${order.title}`,
            },
            unit_amount: Math.round(amount * 100), // £ → pence
          },
          quantity: 1,
        },
      ],
      metadata: {
        orderId,
        paymentType: type,
      },
      success_url: `${FRONTEND_URL}/payment-success?order=${orderId}`,
      cancel_url: `${FRONTEND_URL}/payment-cancelled?order=${orderId}`,
      customer_email: order.email,
    });

    const paymentUrl = session.url;
    console.log(`✅ Created ${type} payment session for order ${orderId}`);
    console.log(`🔗 Payment link: ${paymentUrl}`);

    // 💌 Send beautifully styled payment email
    await sendEmail({
      to: order.email,
      subject: `Secure ${type} payment link — ${order.title}`,
      html: paymentRequestTemplate({
        customerName: order.name,
        orderTitle: order.title,
        amount,
        link: paymentUrl,
        type,
      }),
      text: `Hello ${order.name},

You can complete your ${type} payment of £${amount.toFixed(2)} for your order "${order.title}" using the secure Stripe link below:

${paymentUrl}

Once paid, your order balance will update automatically.

— PJH Web Services
`,
    });

    // ✅ Return checkout URL to frontend
    res.json({ success: true, url: paymentUrl });
  } catch (err) {
    console.error("❌ Error creating payment session:", err);
    res.status(500).json({
      success: false,
      error: "Failed to create Stripe session",
      details: err.message,
    });
  }
});

export default router;
