import express from "express";
import directDebitRouter from "./directdebit.js";

const router = express.Router();

// 🧩 Mount sub-routes
router.use("/directdebit", directDebitRouter);

export default router;
