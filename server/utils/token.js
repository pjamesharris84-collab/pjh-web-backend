/**
 * ============================================================
 * PJH Web Services — Token Utility
 * ============================================================
 * Generates secure random tokens used for quote responses,
 * invoice confirmation links, etc.
 *
 * Example use:
 *   const token = generateResponseToken();
 *   // → "2f8d9e1c89d44b7b8e821f4732cb69e2..."
 * ============================================================
 */

import crypto from "crypto";

/**
 * Generate a unique, cryptographically secure token
 * @returns {string} 64-character hex string
 */
export function generateResponseToken() {
  return crypto.randomBytes(32).toString("hex");
}
