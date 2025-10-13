import express from "express";
import directdebit from "./directdebit.js";

const router = express.Router();
router.use("/directdebit", directdebit);
export default router;
