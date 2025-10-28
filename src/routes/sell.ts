import { Router } from 'express';
import db from '../db';
import { RowDataPacket } from 'mysql2';
import { authMiddleware, AuthRequest } from '../middleware/authMiddleware';

const router = Router();

// --- Helper functions (Keep existing) ---
const getCurrentGoldPrice = async (): Promise<number> => {
    // ... (Keep existing implementation) ...
    const [rows] = await db.query<RowDataPacket[]>(
        "SELECT setting_value FROM app_settings WHERE setting_key = 'current_gold_price'"
    );
    if (rows.length === 0) throw new Error('Gold price not set');
    const price = parseFloat(rows[0].setting_value);
    if (isNaN(price) || price <= 0) throw new Error('Invalid gold price.');
    return price;
};

// Helper function to get user's current gold balance
const getUserGoldBalance = async (userId: number): Promise<number> => {
    const [rows] = await db.query<RowDataPacket[]>(
        'SELECT total_grams FROM portfolio WHERE user_id = ?',
        [userId]
    );
    return rows.length > 0 ? parseFloat(rows[0].total_grams) : 0;
};

// --- NEW Helper: Get User's Required Withdrawal Details ---
const getRequiredUserDetails = async (userId: number): Promise<RowDataPacket | null> => {
    const [rows] = await db.query<RowDataPacket[]>(
        `SELECT bank_account_name, bank_account_number, bank_ifsc_code, 
                pan_card_number, aadhaar_card_number
         FROM users WHERE id = ?`,
        [userId]
    );
    return rows.length > 0 ? rows[0] : null;
};
// --- End Helper ---


/**
 * @route   POST /api/sell/request
 * @desc    User requests to sell gold (creates a pending withdrawal transaction)
 * @access  Private
 */
router.post('/request', authMiddleware, async (req: AuthRequest, res) => {
  const { gramsToSell } = req.body;
  const userId = req.user?.userId;

  if (!userId) {
    return res.status(401).json({ message: 'User not authenticated' });
  }

  const grams = parseFloat(gramsToSell);
  if (isNaN(grams) || grams <= 0) {
    return res.status(400).json({ message: 'Invalid amount of grams specified' });
  }

  let connection;
  try {
    // 1. Check Mandatory Bank/KYC Details
    const userDetails = await getRequiredUserDetails(userId);

    if (!userDetails || 
        !userDetails.bank_account_name || !userDetails.bank_account_number || !userDetails.bank_ifsc_code ||
        !userDetails.pan_card_number || !userDetails.aadhaar_card_number
        ) {
        // Return a specific error instructing the user to update their profile
        return res.status(403).json({ 
            message: 'Withdrawal requires complete KYC and Bank Account details. Please update your Profile & Settings.',
            code: 'KYC_REQUIRED' // Use a specific error code for frontend handling
        });
    }

    // 2. Check Gold Balance
    const currentBalance = await getUserGoldBalance(userId);
    if (currentBalance < grams) {
        return res.status(400).json({ message: `Insufficient gold balance. You have ${currentBalance.toFixed(4)}g.` });
    }

    // 3. Proceed with transaction creation
    const pricePerGram = await getCurrentGoldPrice();
    const amountInr = parseFloat((grams * pricePerGram).toFixed(2)); // Calculate INR value

    connection = await db.getConnection();
    await connection.beginTransaction();

    // Insert a 'pending' withdrawal transaction
    await connection.query(
      `INSERT INTO transactions
         (user_id, type, status, amount_inr, grams, price_per_gram)
       VALUES (?, 'withdraw', 'pending', ?, ?, ?)`,
      [userId, amountInr, grams, pricePerGram]
    );

    await connection.commit();

    res.status(201).json({
      message: 'Withdrawal request submitted successfully. Waiting for admin approval.',
      gramsRequested: grams,
      estimatedValue: amountInr,
    });
  } catch (error: any) {
    if (connection) await connection.rollback();
    console.error('[Sell Request Error]:', error.message);
    res.status(500).json({ message: 'Server error during withdrawal request', error: error.message });
  } finally {
    if (connection) connection.release();
  }
});

export default router;