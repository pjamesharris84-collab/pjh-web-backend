import express from "express";
import directDebitRouter from "./directdebit.js";

const router = express.Router();

// Mount correctly at /api/automation/directdebit/...
router.use("/directdebit", directDebitRouter);

export default router;
