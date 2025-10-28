import { Router } from 'express';
import db from '../db';
import { authMiddleware, adminMiddleware, AuthRequest } from '../middleware/authMiddleware';
import { RowDataPacket } from 'mysql2';

const router = Router();

// --- Helper functions ---
const getCurrentGoldPrice = async (): Promise<number> => {
    // Keep your existing robust implementation with error handling
    try {
        console.log("[Admin Route - getCurrentGoldPrice] Fetching...");
        const [rows] = await db.query<RowDataPacket[]>(
          "SELECT setting_value FROM app_settings WHERE setting_key = 'current_gold_price'"
        );
        if (rows.length === 0 || !rows[0].setting_value) {
            throw new Error('Gold price not found.');
        }
        const price = parseFloat(rows[0].setting_value);
        if (isNaN(price) || price <= 0) {
            throw new Error(`Invalid gold price in DB: ${rows[0].setting_value}`);
        }
        console.log(`[Admin Route - getCurrentGoldPrice] Success: ${price}`);
        return price;
    } catch (err: any) {
        console.error("[Admin Route - getCurrentGoldPrice] Error:", err);
        throw new Error('Could not fetch valid gold price.');
    }
};
// --- End Helper functions ---


// --- (EXISTING) UPDATE GOLD PRICE (Admin Only) ---
router.post('/price', authMiddleware, adminMiddleware, async (req, res) => {
  const { newPrice } = req.body;
  if (!newPrice || isNaN(parseFloat(newPrice))) {
    return res.status(400).json({ message: 'Invalid price' });
  }
  try {
    // 1. Update current price
    await db.query(
      "UPDATE app_settings SET setting_value = ? WHERE setting_key = 'current_gold_price'",
      [newPrice]
    );
    // 2. Update/Insert today's history
    await db.query(
      `INSERT INTO price_history (price_date, price_value)
       VALUES (CURDATE(), ?)
       ON DUPLICATE KEY UPDATE price_value = ?`,
      [newPrice, newPrice]
    );
    res.json({ message: 'Gold price updated successfully' });
  } catch (error: any) { // Added type annotation
    console.error("Error updating gold price:", error);
    res.status(500).json({ message: 'Server error updating price', error: error.message });
  }
});

// --- (EXISTING) GET ALL USERS WITH PORTFOLIO (Admin Only) ---
router.get('/users-portfolio', authMiddleware, adminMiddleware, async (req: AuthRequest, res) => {
  try {
    const pricePerGram = await getCurrentGoldPrice();

    // FIX: Include all bank and KYC columns in the main user select
    const [users] = await db.query<RowDataPacket[]>(
      `SELECT
         u.id, u.name, u.email, u.phone, u.role, u.created_at,
         u.bank_account_name, u.bank_account_number, u.bank_ifsc_code,
         u.pan_card_number, u.aadhaar_card_number,  -- <-- ADDED KYC/BANK DETAILS
         COALESCE(p.total_grams, 0) AS totalGrams,
         COALESCE(t.totalInvested, 0) AS totalInvested
       FROM users u
       LEFT JOIN portfolio p ON u.id = p.user_id
       LEFT JOIN (
         SELECT user_id, SUM(amount_inr) as totalInvested
         FROM transactions
         WHERE type = 'buy' AND status = 'completed'
         GROUP BY user_id
       ) t ON u.id = t.user_id
       WHERE u.role = 'user'
       ORDER BY u.name`
    );

    const usersWithCalculations = users.map(user => {
      const totalGrams = parseFloat(user.totalGrams as string); // Ensure conversion
      const totalInvested = parseFloat(user.totalInvested as string); // Ensure conversion
      const currentValue = totalGrams * pricePerGram;
      const profit = currentValue - totalInvested;
      return {
        ...user,
        totalGrams, // Send as number
        totalInvested, // Send as number
        currentValue: parseFloat(currentValue.toFixed(2)),
        profit: parseFloat(profit.toFixed(2))
      };
    });

    res.json(usersWithCalculations);
  } catch (error: any) {
    console.error("Error fetching users portfolio:", error);
    res.status(500).json({ message: 'Server error fetching users portfolio', error: error.message });
  }
});

// --- (EXISTING) GET ALL ADMINS (Admin Only) ---
router.get('/admins', authMiddleware, adminMiddleware, async (req: AuthRequest, res) => {
  try {
    const [rows] = await db.query<RowDataPacket[]>(
      "SELECT id, name, email, phone, created_at FROM users WHERE role = 'admin' ORDER BY name"
    );
    res.json(rows);
  } catch (error: any) {
    console.error("Error fetching admins:", error);
    res.status(500).json({ message: 'Server error fetching admins', error: error.message });
  }
});

// --- (EXISTING) PROMOTE A USER TO ADMIN (Admin Only) ---
router.post('/promote-admin', authMiddleware, adminMiddleware, async (req: AuthRequest, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ message: 'Email is required' });
  }

  try {
    const [users] = await db.query<RowDataPacket[]>(
      'SELECT * FROM users WHERE email = ?',
      [email]
    );
    if (users.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }
    if (users[0].role === 'admin') {
      return res.status(409).json({ message: 'User is already an admin' });
    }

    await db.query("UPDATE users SET role = 'admin' WHERE email = ?", [email]);
    res.json({ message: `User ${email} has been promoted to admin` });
  } catch (error: any) {
    console.error("Error promoting user:", error);
    res.status(500).json({ message: 'Server error promoting user', error: error.message });
  }
});

// --- (EXISTING) GET ALL TRANSACTIONS (Admin Only) ---
router.get('/transactions', authMiddleware, adminMiddleware, async (req: AuthRequest, res) => {
  try {
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT t.id, t.type, t.status, t.amount_inr, t.grams, t.created_at, t.rejected_reason, u.name, u.email
       FROM transactions t
       JOIN users u ON t.user_id = u.id
       ORDER BY t.created_at DESC`
    );
    res.json(rows);
  } catch (error: any) {
    console.error("Error fetching all transactions:", error);
    res.status(500).json({ message: 'Server error fetching transactions', error: error.message });
  }
});


// ===============================================
// --- UPDATED: WITHDRAWAL MANAGEMENT ROUTES ---
// ===============================================

/**
 * @route   GET /api/admin/withdrawals/pending
 * @desc    Get all pending withdrawal requests
 * @access  Admin
 */
router.get('/withdrawals/pending', authMiddleware, adminMiddleware, async (req: AuthRequest, res) => {
    console.log("[Admin] Fetching pending withdrawal requests...");
    try {
        const [rows] = await db.query<RowDataPacket[]>(
            `SELECT t.id, t.user_id, t.amount_inr, t.grams, t.price_per_gram, t.created_at, t.status, -- <-- ADDED STATUS
             u.name, u.email, u.phone,
             u.bank_account_name, u.bank_account_number, u.bank_ifsc_code 
             FROM transactions t
             JOIN users u ON t.user_id = u.id
             WHERE t.type = 'withdraw' AND t.status = 'pending' -- <-- ONLY PENDING
             ORDER BY t.created_at ASC` 
        );
        console.log(`[Admin] Found ${rows.length} pending requests.`);
        res.json(rows);
    } catch (error: any) {
        console.error("[Admin] Error fetching pending withdrawals:", error);
        res.status(500).json({ message: "Server error fetching pending withdrawals", error: error.message });
    }
});


/**
 * @route   POST /api/admin/withdrawals/:id/approve
 * @desc    Approve, execute, and mark a pending withdrawal request as COMPLETED (Single-step)
 * @access  Admin
 */
router.post('/withdrawals/:id/approve', authMiddleware, adminMiddleware, async (req: AuthRequest, res) => {
    const transactionId = parseInt(req.params.id, 10);
    // NEW: Get the reference ID/Order ID from the request body
    const { referenceId } = req.body; 
    console.log(`[Admin] Attempting to approve/complete withdrawal ID: ${transactionId} with Ref/Order ID: ${referenceId}`);

    if (isNaN(transactionId)) {
        return res.status(400).json({ message: 'Invalid transaction ID' });
    }
    // NEW: Validation for required reference ID
    if (!referenceId || typeof referenceId !== 'string' || referenceId.trim() === '') {
        return res.status(400).json({ message: 'Reference ID (UTR/Order ID) is required to complete the payout.' });
    }

    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();
        console.log(`[Admin Approve/Complete ${transactionId}] DB Transaction Started.`);

        // 1. Find the PENDING withdrawal transaction & Lock
        const [rows] = await connection.query<RowDataPacket[]>(
            `SELECT * FROM transactions WHERE id = ? AND type = 'withdraw' AND status = 'pending' FOR UPDATE`,
            [transactionId]
        );

        if (rows.length === 0) {
            await connection.rollback();
            console.log(`[Admin Approve/Complete ${transactionId}] Pending request not found.`);
            return res.status(404).json({ message: 'Pending withdrawal request not found or already processed.' });
        }
        const transaction = rows[0];
        const userId = transaction.user_id;
        const gramsToWithdraw = parseFloat(transaction.grams);
        console.log(`[Admin Approve/Complete ${transactionId}] Found pending request for user ${userId}, grams: ${gramsToWithdraw}.`);

        // 2. Double-check user's balance & Lock
        const [portfolioRows] = await connection.query<RowDataPacket[]>(
            `SELECT total_grams FROM portfolio WHERE user_id = ? FOR UPDATE`,
            [userId]
        );
        const currentBalance = portfolioRows.length > 0 ? parseFloat(portfolioRows[0].total_grams) : 0;
        console.log(`[Admin Approve/Complete ${transactionId}] Current user balance: ${currentBalance}g.`);


        if (currentBalance < gramsToWithdraw) {
            // Balance insufficient: Reject instead of approving
            await connection.query(
                `UPDATE transactions SET status = 'rejected', rejected_reason = ? WHERE id = ?`,
                ['Insufficient balance at time of approval/payout', transactionId]
            );
            await connection.commit(); // Commit the rejection
            console.warn(`[Admin Approve/Complete ${transactionId}] Rejected due to insufficient balance.`);
            return res.status(400).json({ message: `User balance insufficient (${currentBalance.toFixed(4)}g). Request automatically rejected.` });
        }

        // 3. Update transaction status to 'completed' AND set the cashfree_order_id
        await connection.query(
            `UPDATE transactions SET status = 'completed', rejected_reason = NULL, cashfree_order_id = ? WHERE id = ?`, 
            [referenceId.trim(), transactionId]
        );
         console.log(`[Admin Approve/Complete ${transactionId}] Transaction status updated to 'completed' and cashfree_order_id set.`);

        // 4. Decrease user's gold balance
         await connection.query(
            `INSERT INTO portfolio (user_id, total_grams) VALUES (?, 0)
             ON DUPLICATE KEY UPDATE total_grams = total_grams - ?`,
            [userId, gramsToWithdraw]
        );
        // Add safety check: Ensure balance doesn't go negative
        await connection.query(
             `UPDATE portfolio SET total_grams = GREATEST(0, total_grams) WHERE user_id = ?`,
             [userId]
        );
        console.log(`[Admin Approve/Complete ${transactionId}] User portfolio updated.`);


        // 5. Commit the transaction
        await connection.commit();
        console.log(`[Admin Approve/Complete ${transactionId}] DB Transaction Committed.`);

        res.json({ message: `Withdrawal request ${transactionId} approved and completed with Order ID ${referenceId}.` });

    } catch (error: any) {
        if (connection) await connection.rollback();
        console.error(`[Admin Approve/Complete ${transactionId}] Error:`, error);
        res.status(500).json({ message: 'Server error during withdrawal approval/completion', error: error.message });
    } finally {
        if (connection) connection.release();
    }
});


/**
 * @route   POST /api/admin/withdrawals/:id/reject
 * @desc    Reject a pending withdrawal request (Logic remains the same)
 * @access  Admin
 */
router.post('/withdrawals/:id/reject', authMiddleware, adminMiddleware, async (req: AuthRequest, res) => {
    const transactionId = parseInt(req.params.id, 10);
    const { reason } = req.body;
    console.log(`[Admin] Attempting to reject withdrawal ID: ${transactionId} with reason: ${reason}`);


    if (isNaN(transactionId)) {
        return res.status(400).json({ message: 'Invalid transaction ID' });
    }
    if (!reason || typeof reason !== 'string' || reason.trim() === '') { // Validate reason
        return res.status(400).json({ message: 'Rejection reason is required and must be text' });
    }


    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();
        console.log(`[Admin Reject ${transactionId}] DB Transaction Started.`);


        // Find the PENDING withdrawal transaction & lock
        const [rows] = await connection.query<RowDataPacket[]>(
            `SELECT id, user_id FROM transactions WHERE id = ? AND type = 'withdraw' AND status = 'pending' FOR UPDATE`,
            [transactionId]
        );

        if (rows.length === 0) {
            await connection.rollback();
             console.log(`[Admin Reject ${transactionId}] Pending request not found.`);
            return res.status(404).json({ message: 'Pending withdrawal request not found or already processed.' });
        }
        const userId = rows[0].user_id;

        // Update status to 'rejected' and add reason
        await connection.query(
            `UPDATE transactions SET status = 'rejected', rejected_reason = ? WHERE id = ?`,
            [reason.trim(), transactionId] // Trim reason
        );
        console.log(`[Admin Reject ${transactionId}] Transaction status updated to 'rejected'.`);


        await connection.commit();
         console.log(`[Admin Reject ${transactionId}] DB Transaction Committed.`);

        // --- TODO: Notify User ---
        console.log(`Withdrawal request ${transactionId} for user ${userId} rejected. Reason: ${reason}`);
        // --- End Notify ---

        res.json({ message: `Withdrawal request ${transactionId} rejected.` });

    } catch (error: any) {
        if (connection) await connection.rollback();
        console.error(`[Admin Reject ${transactionId}] Error:`, error);
        res.status(500).json({ message: 'Server error during withdrawal rejection', error: error.message });
    } finally {
        if (connection) connection.release();
    }
});


export default router;