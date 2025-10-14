import express from "express";
import directDebitRouter from "./directdebit.js";
import directDebitBuildRouter from "./directdebitBuild.js";

const router = express.Router();

// Distinct endpoints for clarity
router.use("/directdebit", directDebitRouter);          // → /api/automation/directdebit/run
router.use("/directdebit", directDebitBuildRouter);

export default router;
