import pool from "../db.js";

/**
 * Generate a unique quote number for a given customer.
 * Format: PJH-WS/{BUSINESS}/{SEQUENTIAL_ID}
 * Example: PJH-WS/ACME-LTD/000001
 *
 * @param {number|string} customerId - The customer's database ID.
 * @param {string} businessName - The customer's business name (optional).
 * @returns {Promise<string>} The generated quote number.
 */
export async function generateQuoteNumber(customerId, businessName = "Customer") {
  if (!customerId) {
    throw new Error("❌ generateQuoteNumber: Missing customerId");
  }

  // -----------------------------
  // Sanitise & format the business name
  // -----------------------------
  const safeBusiness = businessName
    ? businessName
        .trim()
        .replace(/[^a-zA-Z0-9\s-]/g, "") // remove any weird symbols
        .replace(/\s+/g, "-") // spaces to hyphens
        .toUpperCase()
    : "CUSTOMER";

  // -----------------------------
  // Count how many quotes exist for this customer
  // -----------------------------
  let count = 1; // default if no previous quotes
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM quotes WHERE customer_id = $1`,
      [customerId]
    );
    if (rows && rows[0]) {
      count = rows[0].count + 1;
    }
  } catch (err) {
    console.error("⚠️ Failed to fetch existing quote count:", err.message);
    // fall back to random number to avoid total failure
    count = Math.floor(Math.random() * 1000);
  }

  // -----------------------------
  // Build the final quote reference
  // -----------------------------
  const paddedCount = String(count).padStart(6, "0");
  const quoteNumber = `PJH-WS/${safeBusiness}/${paddedCount}`;

  console.log(`🧾 Generated Quote Number: ${quoteNumber}`);

  return quoteNumber;
}
