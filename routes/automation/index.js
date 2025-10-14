import express from "express";
import directDebitRouter from "./directdebit.js";
import directDebitBuildRouter from "./directdebitBuild.js";

const router = express.Router();

// Distinct endpoints for clarity
router.use("/directdebit", directDebitRouter);          // → /api/automation/directdebit/run
router.use("/directdebit-build", directDebitBuildRouter); // → /api/automation/directdebit-build/run

export default router;
