// ============================================
// PJH Web Services — Stripe Payment Session Routes
// ============================================

import express from "express";
import Stripe from "stripe";
import dotenv from "dotenv";
import pool from "../db.js";
import { sendEmail } from "../utils/email.js";

dotenv.config();

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-09-30",
});

/**
 * POST /api/payments/create-session
 * Create a Stripe Checkout session for deposit or balance
 */
router.post("/create-session", async (req, res) => {
  const { orderId, type } = req.body;

  if (!orderId || !["deposit", "balance"].includes(type)) {
    return res
      .status(400)
      .json({ success: false, error: "Invalid orderId or payment type" });
  }

  try {
    // 🔍 Get order & customer info
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
    const amount =
      type === "deposit"
        ? Number(order.deposit)
        : Number(order.balance);

    if (amount <= 0) {
      return res
        .status(400)
        .json({ success: false, error: "No outstanding amount for this stage" });
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
            unit_amount: Math.round(amount * 100), // convert £ to pence
          },
          quantity: 1,
        },
      ],
      metadata: {
        orderId,
        paymentType: type,
      },
      success_url: `${process.env.FRONTEND_URL}/payment-success?order=${orderId}`,
      cancel_url: `${process.env.FRONTEND_URL}/payment-cancelled?order=${orderId}`,
      customer_email: order.email,
    });

    console.log(`✅ Created ${type} payment session for order ${orderId}`);

    // 📨 Email payment link automatically (optional)
    const paymentUrl = session.url;

    await sendEmail({
      to: order.email,
      subject: `Secure ${type} payment link — ${order.title}`,
      text: `Hello ${order.name},

You can complete your ${type} payment of £${amount.toFixed(2)} for your order "${order.title}" using the secure Stripe link below:

${paymentUrl}

Once paid, your order balance will update automatically.

— PJH Web Services
`,
    });

    res.json({ success: true, url: paymentUrl });
  } catch (err) {
    console.error("❌ Error creating payment session:", err.message);
    res
      .status(500)
      .json({ success: false, error: "Failed to create Stripe session" });
  }
});

export default router;
