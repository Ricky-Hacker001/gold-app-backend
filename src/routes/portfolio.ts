import { Router } from 'express';
import db from '../db';
import { authMiddleware, AuthRequest } from '../middleware/authMiddleware';
import { RowDataPacket } from 'mysql2';

const router = Router();

// Helper to get current price
const getCurrentGoldPrice = async (): Promise<number> => {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT setting_value FROM app_settings WHERE setting_key = 'current_gold_price'"
  );
  if (rows.length === 0) return 0;
  return parseFloat(rows[0].setting_value);
};

/**
 * @route   GET /api/portfolio
 * @desc    Get current user's portfolio (grams, value, investment, profit)
 * @access  Private
 */
router.get('/', authMiddleware, async (req: AuthRequest, res) => {
  const userId = req.user?.userId;
  try {
    // --- Query 1: Get Total Grams ---
    const [portfolioRows] = await db.query<RowDataPacket[]>(
      'SELECT total_grams FROM portfolio WHERE user_id = ?',
      [userId]
    );

    let totalGrams = 0;
    if (portfolioRows.length > 0) {
      totalGrams = parseFloat(portfolioRows[0].total_grams);
    }

    // --- Query 2: Get Total Invested Amount ---
    // Sums all 'completed' 'buy' transactions for the user
    const [investedRows] = await db.query<RowDataPacket[]>(
      `SELECT SUM(amount_inr) AS totalInvested 
       FROM transactions 
       WHERE user_id = ? AND type = 'buy' AND status = 'completed'`,
      [userId]
    );

    let totalInvested = 0;
    if (investedRows.length > 0 && investedRows[0].totalInvested !== null) {
      totalInvested = parseFloat(investedRows[0].totalInvested);
    }

    // --- Calculations ---
    const pricePerGram = await getCurrentGoldPrice();
    const currentValue = totalGrams * pricePerGram;
    const profit = currentValue - totalInvested;

    // --- Send all data ---
    res.json({
      totalGrams,
      currentValue,
      totalInvested, // <-- NEW
      profit,        // <-- NEW
      pricePerGram,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;