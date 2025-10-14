import express from "express";
import directDebitRouter from "./directdebit.js";
import directDebitBuildRouter from "./directdebitBuild.js"; 

const router = express.Router();

// Mount correctly at /api/automation/directdebit/...
router.use("/directdebit", directDebitRouter);
router.use("/directdebit", directDebitBuildRouter);

export default router;
