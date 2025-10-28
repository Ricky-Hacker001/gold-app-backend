import { Router } from 'express';
import db from '../db';
import { RowDataPacket } from 'mysql2';
import { authMiddleware, AuthRequest } from '../middleware/authMiddleware';

// --- START CASHFREE IMPORT & CONFIG ---
const { Cashfree, CFEnvironment } = require('cashfree-pg');

let cashfreeInstance: any; 
try {
  // *** PRODUCTION ENVIRONMENT - MATCHES LIVE KEYS ***
  const environment = CFEnvironment?.PRODUCTION; 
  
  if (!environment) {
    const prodEnv = (Cashfree && Cashfree.Environment && Cashfree.Environment.PRODUCTION) || (Cashfree && Cashfree.PRODUCTION);
    if (!prodEnv) {
      throw new Error('Cashfree PRODUCTION environment is not defined in the imported module. Check SDK version/exports.');
    }
    console.warn("Using fallback for Cashfree environment setting.");
    cashfreeInstance = new Cashfree(
      prodEnv,
      process.env.CASHFREE_APP_ID || '', 
      process.env.CASHFREE_SECRET_KEY || ''
    );
  } else {
    cashfreeInstance = new Cashfree(
      environment,
      process.env.CASHFREE_APP_ID || '', 
      process.env.CASHFREE_SECRET_KEY || ''
    );
  }

  console.log("Cashfree SDK Instance Initialized Successfully for LIVE PRODUCTION (via ngrok).");

} catch (initError: any) {
  console.error("!!! FATAL: Failed to initialize Cashfree SDK for PRODUCTION !!!", initError);
}
// --- END CASHFREE IMPORT & CONFIG ---

const router = Router();

// --- Helper functions (Unchanged) ---
const getCurrentGoldPrice = async (): Promise<number> => {
// ... (getCurrentGoldPrice function remains unchanged) ...
  try {
    console.log("[getCurrentGoldPrice] Fetching...");
    const [rows] = await db.query<RowDataPacket[]>(
      "SELECT setting_value FROM app_settings WHERE setting_key = 'current_gold_price'"
    );
    if (rows.length === 0 || !rows[0].setting_value) {
        console.error("[getCurrentGoldPrice] Gold price not found in settings.");
        throw new Error('Gold price not found in settings.');
    }
    const price = parseFloat(rows[0].setting_value);
    if (isNaN(price) || price <= 0) {
        console.error(`[getCurrentGoldPrice] Invalid gold price found in DB: ${rows[0].setting_value}`);
        throw new Error(`Invalid gold price in DB: ${rows[0].setting_value}`);
    }
    console.log(`[getCurrentGoldPrice] Success: ${price}`);
    return price;
  } catch (err: any) { 
      console.error("[getCurrentGoldPrice] Database or Parsing Error:", err); 
      throw new Error('Could not fetch a valid gold price.'); 
  }
};

const getUserDetails = async (userId: number): Promise<RowDataPacket> => {
  console.log(`[getUserDetails] Fetching for User ID: ${userId}`); 
  const [rows] = await db.query<RowDataPacket[]>(
    'SELECT name, email, phone FROM users WHERE id = ?',
    [userId]
  );
  if (rows.length === 0) {
      console.error(`[getUserDetails] User not found for ID: ${userId}`);
      throw new Error(`User not found for ID: ${userId}`);
  }
  console.log(`[getUserDetails] Found: ${rows[0].email}`); 
  return rows[0];
};
// --- End Helper functions ---

/**
 * @route   POST /api/buy/create-order
 * @desc    Create a new 'pending' transaction and get a Cashfree payment session
 * @access  Private
 */
router.post('/create-order', authMiddleware, async (req: AuthRequest, res) => {
  const { amountInRupees } = req.body;
  const userId = req.user?.userId;

  if (!userId) { return res.status(401).json({ message: 'User not authenticated' }); }
  const amount = parseFloat(amountInRupees);
  if (isNaN(amount) || amount <= 0) { return res.status(400).json({ message: 'Invalid amount requested' }); }

  if (!cashfreeInstance) {
      console.error("[Create Order] Cashfree SDK instance is not available!");
      return res.status(500).json({ message: 'Payment service initialization failed.' });
  }

  let connection;
  try {
    const pricePerGram = await getCurrentGoldPrice();
    const grams = parseFloat((amount / pricePerGram).toFixed(4));
    if (isNaN(grams) || grams <= 0) { return res.status(400).json({ message: 'Invalid calculated gold amount.'}); }
    const user = await getUserDetails(userId);

    connection = await db.getConnection();
    await connection.beginTransaction();
    console.log("[Create Order] DB Transaction Started.");

    // 1. Insert pending transaction
    const [result] = await connection.query<any>(
        `INSERT INTO transactions (user_id, type, status, amount_inr, grams, price_per_gram)
         VALUES (?, 'buy', 'pending', ?, ?, ?)`,
        [userId, amount, grams, pricePerGram]
    );
    if (!result || !result.insertId) {
        await connection.rollback();
        throw new Error('Failed to insert transaction or get transaction ID.');
    }
    const transactionId = result.insertId;
    console.log(`[Create Order] Pending Transaction Inserted (ID: ${transactionId}).`);
    const cashfreeOrderId = `GOLD_TXN_${userId}_${transactionId}_${Date.now()}`;

    // 2. Create Cashfree order request payload
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
        // *** CRITICAL FIX: The complete ngrok URL is used here ***
        // Assumed full URL: https://bd5c810a6147.ngrok-free.app/
        return_url: `https://bd5c810a6147.ngrok-free.app/payment-status?order_id={order_id}`, 
      },
      order_note: `Purchase of ${grams.toFixed(4)}g gold.`,
    };
    console.log("[Create Order] Cashfree Request Payload:", JSON.stringify(cashfreeOrderRequest, null, 2));


    // --- 3. Call PGCreateOrder method directly on the INSTANCE (Uses Live API) ---
    console.log("[Create Order] Calling instance method cashfreeInstance.PGCreateOrder...");
    if (typeof cashfreeInstance.PGCreateOrder !== 'function') {
        await connection.rollback();
        throw new Error('Cashfree SDK method PGCreateOrder not found on instance.');
    }
    const cashfreeResponse = await cashfreeInstance.PGCreateOrder(cashfreeOrderRequest);
    console.log("[Create Order] Cashfree API Response Received.");


    // 4. Update transaction
    await connection.query(
      'UPDATE transactions SET cashfree_order_id = ? WHERE id = ?',
      [cashfreeOrderId, transactionId]
    );
    console.log(`[Create Order] Transaction ${transactionId} updated with CF Order ID.`);

    // 5. Commit
    await connection.commit();
    console.log("[Create Order] DB Transaction Committed.");

    // 6. Send response
    res.status(200).json({
      paymentSessionId: cashfreeResponse.data.payment_session_id,
    });

  } catch (error: any) {
    if (connection) {
        console.log("[Create Order] Rolling back DB Transaction due to error.");
        await connection.rollback();
    }
    const errorMessage = error.response?.data?.message || error.message || 'Unknown server error';
    const errorDetails = error.response?.data || error;
    console.error('[Create Order] Error:', errorMessage, 'Details:', JSON.stringify(errorDetails, null, 2));
    res.status(500).json({ message: `Server error during order creation: ${errorMessage}`, error: errorDetails });
  } finally {
    if (connection) {
        connection.release();
        console.log("[Create Order] DB Connection Released.");
    }
  }
});

/**
 * @route   POST /api/buy/verify-payment
 * @desc    Verify the payment with Cashfree and update the transaction
 * @access  Private
 */
router.post('/verify-payment', authMiddleware, async (req: AuthRequest, res) => {
// ... (Verify route remains unchanged) ...
  const { order_id } = req.body; 
  const userId = req.user?.userId;
  console.log(`[Verify Payment] Request: Order ID=${order_id}, User ID=${userId}`);

  if (!order_id) { return res.status(400).json({ message: 'Order ID is required' }); }
  if (!userId) { return res.status(401).json({ message: 'User not authenticated' }); }
  if (!cashfreeInstance) { return res.status(500).json({ message: 'Payment service unavailable.' }); }

  let connection;
  try {
    // 1. Fetch order status from Cashfree (Uses Live API)
    console.log(`[Verify Payment] Fetching order from Cashfree: ${order_id}`);
    if (typeof cashfreeInstance.PGFetchOrder !== 'function') { 
        throw new Error('Cashfree SDK method PGFetchOrder not found on instance.');
    }
    const verificationResponse = await cashfreeInstance.PGFetchOrder(order_id); 
    const order = verificationResponse.data;
    const cashfreeStatus = order.order_status;
    console.log(`[Verify Payment] Cashfree Status: ${cashfreeStatus}`);

    const terminalFailureStatuses = ['FAILED', 'EXPIRED', 'CANCELLED'];

    if (cashfreeStatus === 'PAID') {
        connection = await db.getConnection();
        await connection.beginTransaction();

        const [rows] = await connection.query<RowDataPacket[]>(
            'SELECT * FROM transactions WHERE cashfree_order_id = ? AND user_id = ? LIMIT 1 FOR UPDATE', 
            [order_id, userId]
        );

        if (rows.length === 0) {
            await connection.rollback();
            try { await connection.release(); } catch(e){}
            connection = null; 
            return res.status(404).json({ message: 'Transaction record not found.' });
        }

        const transaction = rows[0];
        const grams = parseFloat(transaction.grams);

        // --- IDEMPOTENCY CHECK ---
        if (transaction.status === 'completed') {
            await connection.rollback(); 
            try { await connection.release(); } catch(e){}
            connection = null; 
            return res.json({ 
                message: 'Payment previously verified.',
                gramsAdded: grams,
                amountPaid: parseFloat(transaction.amount_inr),
            });
        }
        if (transaction.status !== 'pending') {
            await connection.rollback();
            try { await connection.release(); } catch(e){}
            connection = null;
            return res.status(409).json({ message: `Transaction status is ${transaction.status}. Cannot process.` });
        }
        // --- END IDEMPOTENCY CHECK ---

        if (isNaN(grams) || grams <= 0) {
              await connection.rollback();
              throw new Error(`Invalid grams (${grams}) in pending transaction ID ${transaction.id}.`);
        }
        
        try { 
            // 3. Update transaction status
            await connection.query(
                `UPDATE transactions SET status = 'completed', payment_id = ? WHERE id = ?`,
                [order.cf_order_id, transaction.id]
            );

            // 4. Update user portfolio
            await connection.query(
                `INSERT INTO portfolio (user_id, total_grams) VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE total_grams = total_grams + ?`,
                [userId, grams, grams]
            );

            // 5. Commit
            await connection.commit();

            return res.json({ 
              message: 'Payment verified and gold added!',
              gramsAdded: grams,
              amountPaid: order.order_amount,
            });

        } catch(dbError) {
            console.error("[Verify Payment] Error during DB update transaction:", dbError);
            await connection.rollback(); 
            throw dbError; 
        }

    } else if (terminalFailureStatuses.includes(cashfreeStatus)) {
        connection = await db.getConnection();
        await connection.beginTransaction();

        const [pendingRows] = await connection.query<RowDataPacket[]>(
            'SELECT * FROM transactions WHERE cashfree_order_id = ? AND user_id = ? AND status = ? LIMIT 1',
            [order_id, userId, 'pending']
        );

        if (pendingRows.length > 0) {
            const transactionId = pendingRows[0].id;
            await connection.query(
                `UPDATE transactions SET status = 'failed', payment_id = ? WHERE id = ?`,
                [order.cf_order_id || null, transactionId] 
            );
            await connection.commit();
        } else {
            await connection.rollback();
        }

        try { await connection.release(); } catch(e){}
        connection = null;
        return res.status(400).json({ message: `Payment ${cashfreeStatus.toLowerCase()}` });

    } else {
        try { await connection.release(); } catch(e){}
        connection = null;
        return res.status(400).json({ message: `Payment status is currently ${cashfreeStatus.toLowerCase()}. Please check again later.` });
    }

  } catch (error: any) {
    if (connection) { 
        try { await connection.rollback(); }
        catch (rbError) { console.error("Rollback failed:", rbError); }
    }
    const errorMessage = error.response?.data?.message || error.message || 'Unknown server error';
    const errorDetails = error.response?.data || error;
    console.error('[Verify Payment] Overall Error:', errorMessage, 'Details:', JSON.stringify(errorDetails, null, 2));
    res.status(500).json({ message: `Server error during payment verification: ${errorMessage}`, error: errorDetails });
  } finally {
    if (connection) { 
        try { await connection.release(); } catch (releaseError) { console.error("Release failed:", releaseError);}
    }
  }
});


export default router;