import { Router } from 'express';
import db from '../db';
import { authMiddleware, AuthRequest } from '../middleware/authMiddleware';
import { RowDataPacket } from 'mysql2';

const router = Router();

// --- Helper function to get current price ---
const getCurrentGoldPrice = async (): Promise<number> => {
    try {
        console.log("[Portfolio Route - getCurrentGoldPrice] Fetching...");
        const [rows] = await db.query<RowDataPacket[]>(
          "SELECT setting_value FROM app_settings WHERE setting_key = 'current_gold_price'"
        );
        if (rows.length === 0 || !rows[0].setting_value) {
            console.error("[Portfolio Route - getCurrentGoldPrice] Gold price not found in settings.");
            throw new Error('Gold price not found.');
        }
        const price = parseFloat(rows[0].setting_value);
        if (isNaN(price) || price <= 0) {
             console.error(`[Portfolio Route - getCurrentGoldPrice] Invalid gold price found in DB: ${rows[0].setting_value}`);
            throw new Error(`Invalid gold price in DB: ${rows[0].setting_value}`);
        }
        console.log(`[Portfolio Route - getCurrentGoldPrice] Success: ${price}`);
        return price;
    } catch (err: any) {
        console.error("[Portfolio Route - getCurrentGoldPrice] Error:", err);
        throw new Error('Could not fetch valid gold price.');
    }
};


/**
 * @route   GET /api/portfolio
 * @desc    Get current user's portfolio using Average Cost Basis (Refined)
 * @access  Private
 */
router.get('/', authMiddleware, async (req: AuthRequest, res) => {
  const userId = req.user?.userId;
  if (!userId) {
      return res.status(401).json({ message: "User not authenticated" });
  }
  console.log(`[Portfolio AvgCost V4 - FIX] Fetching portfolio for User ID: ${userId}`);

  try {
    // --- Query 1: Get Total Grams Held NOW ---
    const [portfolioRows] = await db.query<RowDataPacket[]>(
      'SELECT total_grams FROM portfolio WHERE user_id = ?',
      [userId]
    );
    let totalGramsHeld = 0;
    if (portfolioRows.length > 0 && portfolioRows[0].total_grams !== null) {
      totalGramsHeld = parseFloat(portfolioRows[0].total_grams);
    }
    const totalGramsHeldRounded = parseFloat(totalGramsHeld.toFixed(6));
    console.log(`[Portfolio AvgCost V4 - FIX] User ${userId} Total Grams Held: ${totalGramsHeld}`);


    // --- Query 2: Get TOTAL Amount Spent and Grams Purchased EVER ---
    // FIX: CAST amount_inr to DECIMAL to ensure SUM works correctly across MySQL versions
    const [buySummaryRows] = await db.query<RowDataPacket[]>(
      `SELECT SUM(CAST(amount_inr AS DECIMAL(10,2))) AS totalAmountSpent, 
              SUM(grams) AS totalGramsPurchased
       FROM transactions
       WHERE user_id = ? AND type = 'buy' AND status = 'completed'`,
      [userId]
    );

    let totalAmountSpent = 0;
    let totalGramsPurchased = 0;
    
    if (buySummaryRows.length > 0 && buySummaryRows[0].totalAmountSpent !== null) {
      // The CAST in SQL helps ensure this parsing works correctly
      totalAmountSpent = parseFloat(buySummaryRows[0].totalAmountSpent);
      totalGramsPurchased = buySummaryRows[0].totalGramsPurchased !== null ? parseFloat(buySummaryRows[0].totalGramsPurchased) : 0;
    }
    
    const totalGramsPurchasedRounded = parseFloat(totalGramsPurchased.toFixed(6));
    console.log(`[Portfolio AvgCost V4 - FIX] Total Spent (Buys): ${totalAmountSpent}, Total Grams Purchased: ${totalGramsPurchased}`);


    // --- Calculations (Average Cost Basis Logic) ---
    let averageCostPerGram = 0;
    let costBasisOfHeldGold = 0;
    let profitLoss = 0;

    // --- REFINED LOGIC ---
    if (totalGramsPurchasedRounded > 0 && totalGramsHeldRounded > 0) {
        // Standard Average Cost Calculation
        averageCostPerGram = totalAmountSpent / totalGramsPurchased;
        costBasisOfHeldGold = totalGramsHeld * averageCostPerGram;
    } else {
        // Handle zero holds/purchases
        costBasisOfHeldGold = 0;
        averageCostPerGram = 0;
    }

    console.log(`[Portfolio AvgCost V4 - FIX] User ${userId} Final Cost Basis of Held Gold: ${costBasisOfHeldGold}`);


    // Calculate Current Value and Profit/Loss
    const pricePerGram = await getCurrentGoldPrice(); // Fetch current market price
    const currentValue = totalGramsHeld * pricePerGram;
    profitLoss = currentValue - costBasisOfHeldGold; // Profit based on Avg Cost Basis
    console.log(`[Portfolio AvgCost V4 - FIX] User ${userId} Current Value: ${currentValue}, P/L: ${profitLoss}`);


    // --- Send Data ---
    res.json({
      totalGrams: parseFloat(totalGramsHeld.toFixed(4)),
      currentValue: parseFloat(currentValue.toFixed(2)),
      // "investedAmount" now represents the COST BASIS of currently held gold
      investedAmount: parseFloat(costBasisOfHeldGold.toFixed(2)),
      profitLoss: parseFloat(profitLoss.toFixed(2)), // Profit/Loss based on Cost Basis
      pricePerGram: parseFloat(pricePerGram.toFixed(2)),
    });

  } catch (err: any) {
    console.error(`[Portfolio AvgCost V4 - FIX] Error for User ${userId}:`, err.message);
    res.status(500).json({ message: 'Server error fetching portfolio', error: err.message });
  }
});

export default router;