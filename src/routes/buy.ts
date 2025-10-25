import { Router } from 'express';
import db from '../db';
import { RowDataPacket } from 'mysql2';
import { authMiddleware, AuthRequest } from '../middleware/authMiddleware';

// Use the ES Module import style as shown in the docs
import { Cashfree } from 'cashfree-pg';

// Initialize using the constructor (v5 style)
// We create an INSTANCE
const cashfreeInstance = new Cashfree(
    Cashfree.SANDBOX, // Use the Environment enum
    process.env.CASHFREE_APP_ID || '',
    process.env.CASHFREE_SECRET_KEY || ''
);


const router = Router();

// --- (Helper functions: getCurrentGoldPrice & getUserDetails - no change) ---
const getCurrentGoldPrice = async (): Promise<number> => {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT setting_value FROM app_settings WHERE setting_key = 'current_gold_price'"
  );
  if (rows.length === 0) throw new Error('Gold price not set');
  return parseFloat(rows[0].setting_value);
};

const getUserDetails = async (userId: number): Promise<RowDataPacket> => {
  const [rows] = await db.query<RowDataPacket[]>(
    'SELECT name, email, phone FROM users WHERE id = ?',
    [userId]
  );
  if (rows.length === 0) throw new Error('User not found');
  return rows[0];
};
// --- (End of helper functions) ---

/**
 * @route   POST /api/buy/create-order
 * @desc    Create a new 'pending' transaction and get a Cashfree payment session
 * @access  Private
 */
router.post('/create-order', authMiddleware, async (req: AuthRequest, res) => {
  const { amountInRupees } = req.body;
  const userId = req.user?.userId;

  if (!userId) {
    return res.status(401).json({ message: 'User not authenticated' });
  }

  const amount = parseFloat(amountInRupees);
  if (isNaN(amount) || amount <= 0) {
    return res.status(400).json({ message: 'Invalid amount' });
  }

  let connection;
  try {
    const pricePerGram = await getCurrentGoldPrice();
    const grams = parseFloat((amount / pricePerGram).toFixed(4));
    const user = await getUserDetails(userId);

    connection = await db.getConnection();
    await connection.beginTransaction();

    // 1. Insert a 'pending' transaction
    const [insertResult] = await connection.query<any>(
      `INSERT INTO transactions 
         (user_id, type, status, amount_inr, grams, price_per_gram) 
       VALUES (?, 'buy', 'pending', ?, ?, ?)`,
      [userId, amount, grams, pricePerGram]
    );

    const transactionId = insertResult.insertId;
    const cashfreeOrderId = `GOLD_TXN_${userId}_${transactionId}_${Date.now()}`;

    // 2. Create Cashfree order request (Payload is correct)
    const cashfreeOrderRequest = {
      order_id: cashfreeOrderId,
      order_amount: amount,
      order_currency: 'INR',
      customer_details: {
        customer_id: userId.toString(),
        customer_email: user.email,
        customer_phone: user.phone,
        customer_name: user.name,
      },
      order_meta: {
        return_url: `http://localhost:5173/payment-status?order_id={order_id}`,
      },
      order_note: `Purchase of ${grams}g gold.`,
    };

    // --- 3. THIS IS THE FIX (Call the method on the INSTANCE) ---
    const cashfreeResponse = await cashfreeInstance.PGCreateOrder(cashfreeOrderRequest);
    // --- END OF FIX ---

    // 4. Update our transaction with the Cashfree Order ID
    await connection.query(
      'UPDATE transactions SET cashfree_order_id = ? WHERE id = ?',
      [cashfreeOrderId, transactionId]
    );
    
    // 5. Commit our database changes
    await connection.commit();

    // 6. Send the payment session ID to the frontend
    res.status(200).json({
      paymentSessionId: cashfreeResponse.data.payment_session_id,
    });

  } catch (error: any) {
    if (connection) await connection.rollback();
    // Log the actual error structure from Cashfree if available
    console.error('Cashfree error:', error.response?.data?.message || error.message); 
    res.status(500).json({ message: 'Server error during order creation' });
  } finally {
    if (connection) connection.release();
  }
});

/**
 * @route   POST /api/buy/verify-payment
 * @desc    Verify the payment with Cashfree and update the transaction
 * @access  Private
 */
router.post('/verify-payment', authMiddleware, async (req: AuthRequest, res) => {
  const { order_id } = req.body;
  const userId = req.user?.userId;

  if (!order_id) {
    return res.status(400).json({ message: 'Order ID is required' });
  }

  let connection;
  try {
    // 1. Fetch order status from Cashfree
    // --- THIS IS THE SECOND FIX (Call the method on the INSTANCE) ---
    const verificationResponse = await cashfreeInstance.PGFetchOrder(order_id);
    // --- END OF FIX ---
    const order = verificationResponse.data;

    if (order.order_status !== 'PAID') {
      // Payment was not successful
      return res.status(400).json({ message: `Payment not successful (Status: ${order.order_status})` });
    }

    // 2. Payment is 'PAID'. Now, verify in our DB
    connection = await db.getConnection();
    await connection.beginTransaction();

    // Find the 'pending' transaction
    const [rows] = await connection.query<RowDataPacket[]>(
      'SELECT * FROM transactions WHERE cashfree_order_id = ? AND user_id = ? AND status = ?',
      [order_id, userId, 'pending']
    );

    if (rows.length === 0) {
      // This is suspicious. Either already processed or doesn't exist.
      await connection.rollback();
      return res.status(404).json({ message: 'Pending transaction not found. May be already processed.' });
    }

    const transaction = rows[0];
    const grams = parseFloat(transaction.grams);

    // 3. Update our transaction to 'completed'
    await connection.query(
      "UPDATE transactions SET status = 'completed', payment_id = ? WHERE id = ?",
      [order.cf_order_id, transaction.id] // Save Cashfree's internal ID
    );

    // 4. Update the user's portfolio
    await connection.query(
      `INSERT INTO portfolio (user_id, total_grams) 
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE total_grams = total_grams + ?`,
      [userId, grams, grams]
    );

    // 5. Commit the transaction
    await connection.commit();

    res.json({
      message: 'Payment verified and gold added to your portfolio!',
      gramsAdded: grams,
      amountPaid: order.order_amount,
    });

  } catch (error: any) {
    if (connection) await connection.rollback();
    // Log the actual error structure from Cashfree if available
    console.error('Verification error:', error.response?.data?.message || error.message);
    res.status(500).json({ message: 'Server error during payment verification' });
  } finally {
    if (connection) connection.release();
  }
});


export default router;