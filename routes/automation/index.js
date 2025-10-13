import express from "express";
import { runMonthlyDirectDebit } from "./directdebit.js";

const router = express.Router();

// For manual trigger or Render CRON
router.get("/directdebit/run", async (req, res) => {
  const orderId = req.query.orderId ? Number(req.query.orderId) : null;
  await runMonthlyDirectDebit(orderId);
  res.json({ success: true, message: orderId ? "Single order charged" : "Batch run complete" });
});

export default router;
