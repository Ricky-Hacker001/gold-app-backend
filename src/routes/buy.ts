import { Router } from 'express';
import db from '../db';
import { RowDataPacket } from 'mysql2';
import { authMiddleware, AuthRequest } from '../middleware/authMiddleware';

// --- START CASHFREE IMPORT & CONFIG ---
// Use require and destructure BOTH Cashfree class and CFEnvironment enum
const { Cashfree, CFEnvironment } = require('cashfree-pg');

// Initialize using the constructor
let cashfreeInstance: any; // Define variable OUTSIDE try block
try {
  // *** PRODUCTION CHANGE: Switch CFEnvironment.SANDBOX to CFEnvironment.PRODUCTION ***
  // Use CFEnvironment.PRODUCTION for the live environment.
  // The SDK will automatically use the Production API endpoints.
  const environment = CFEnvironment?.PRODUCTION; 
  
  if (!environment) {
    // Fallback if the enum structure is different
    // *** PRODUCTION CHANGE: Fallback to PRODUCTION constants ***
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
    // *** PRODUCTION CHANGE: Use CFEnvironment.PRODUCTION ***
    cashfreeInstance = new Cashfree(
      environment, // Use the destructured enum for PRODUCTION
      process.env.CASHFREE_APP_APPID || '', // NOTE: Ensure you use the LIVE APP ID
      process.env.CASHFREE_SECRET_KEY || '' // NOTE: Ensure you use the LIVE SECRET KEY
    );
  }

  // NOTE: A production setup should ideally use different environment variables 
  // for the Live App ID and Secret Key to prevent accidental use of test keys.
  // For simplicity, we keep the variable names but highlight the need for live keys.

  console.log("Cashfree SDK Instance Initialized Successfully for PRODUCTION.");

} catch (initError: any) {
  console.error("!!! FATAL: Failed to initialize Cashfree SDK for PRODUCTION !!!", initError);
}
// --- END CASHFREE IMPORT & CONFIG ---

const router = Router();

// --- Helper functions (No changes needed) ---
const getCurrentGoldPrice = async (): Promise<number> => {
// ... (Your existing getCurrentGoldPrice function) ...
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
  } catch (err: any) { // Added type annotation
      console.error("[getCurrentGoldPrice] Database or Parsing Error:", err); // Log the full error
      throw new Error('Could not fetch a valid gold price.'); // Re-throw generic
  }
};

const getUserDetails = async (userId: number): Promise<RowDataPacket> => {
  console.log(`[getUserDetails] Fetching for User ID: ${userId}`); // Log start
  const [rows] = await db.query<RowDataPacket[]>(
    'SELECT name, email, phone FROM users WHERE id = ?',
    [userId]
  );
  if (rows.length === 0) {
      console.error(`[getUserDetails] User not found for ID: ${userId}`);
      throw new Error(`User not found for ID: ${userId}`);
  }
  console.log(`[getUserDetails] Found: ${rows[0].email}`); // Log success
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

  // Check if SDK instance exists
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
        customer_phone: user.phone, // Ensure valid format
        customer_name: user.name,
      },
      order_meta: {
        // *** PRODUCTION CHANGE: Update return_url to the LIVE frontend URL ***
        return_url: `${process.env.FRONTEND_LIVE_URL}/payment-status?order_id={order_id}`, // RECOMMENDED: Use an environment variable
        // return_url: `https://yourdomain.com/payment-status?order_id={order_id}`, // Or a hardcoded live URL
      },
      order_note: `Purchase of ${grams.toFixed(4)}g gold.`,
    };
    console.log("[Create Order] Cashfree Request Payload:", JSON.stringify(cashfreeOrderRequest, null, 2));


    // --- 3. Call PGCreateOrder method directly on the INSTANCE ---
    console.log("[Create Order] Calling instance method cashfreeInstance.PGCreateOrder...");
    // Check if the method exists on the instance
    if (typeof cashfreeInstance.PGCreateOrder !== 'function') {
        await connection.rollback();
        console.error("Method cashfreeInstance.PGCreateOrder not found!");
        console.log("Available methods on instance:", Object.keys(cashfreeInstance)); // Log methods again
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
    const errorDetails = error.response?.data || error; // Log full details if available
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
 * @desc    Verify the payment with Cashfree and update the transaction (Handles double calls)
 * @access  Private
 */
router.post('/verify-payment', authMiddleware, async (req: AuthRequest, res) => {
// ... (The verify-payment route needs NO changes, as it uses the already initialized cashfreeInstance) ...
  const { order_id } = req.body; // This is YOUR order_id (cashfreeOrderId)
  const userId = req.user?.userId;
  console.log(`[Verify Payment] Request: Order ID=${order_id}, User ID=${userId}`);

  if (!order_id) { return res.status(400).json({ message: 'Order ID is required' }); }
  if (!userId) { return res.status(401).json({ message: 'User not authenticated' }); }
  if (!cashfreeInstance) { return res.status(500).json({ message: 'Payment service unavailable.' }); }

  let connection;
  try {
    // 1. Fetch order status from Cashfree first (to ensure it's PAID)
    console.log(`[Verify Payment] Fetching order from Cashfree: ${order_id}`);
    if (typeof cashfreeInstance.PGFetchOrder !== 'function') { // Check instance method
        throw new Error('Cashfree SDK method PGFetchOrder not found on instance.');
    }
    const verificationResponse = await cashfreeInstance.PGFetchOrder(order_id); // Call instance method
    const order = verificationResponse.data;
    const cashfreeStatus = order.order_status; // e.g., PAID, ACTIVE, FAILED, EXPIRED, CANCELLED
    console.log(`[Verify Payment] Cashfree Status: ${cashfreeStatus}`);

    // Define Terminal Failure Statuses
    const terminalFailureStatuses = ['FAILED', 'EXPIRED', 'CANCELLED'];

    // Handle Different Statuses
    if (cashfreeStatus === 'PAID') {
        // --- SUCCESS PATH ---
        connection = await db.getConnection();
        await connection.beginTransaction();
        console.log("[Verify Payment] DB Transaction Started (Success Path).");

        // 1. Find the transaction and LOCK it FOR UPDATE
        const [rows] = await connection.query<RowDataPacket[]>(
            'SELECT * FROM transactions WHERE cashfree_order_id = ? AND user_id = ? LIMIT 1 FOR UPDATE', // LOCK ROW
            [order_id, userId]
        );

        if (rows.length === 0) {
            await connection.rollback();
            try { await connection.release(); console.log("[Verify Payment] DB Connection Released (Transaction Not Found)."); } catch(e){}
            connection = null; // Prevent release in finally block
            return res.status(404).json({ message: 'Transaction record not found.' });
        }

        const transaction = rows[0];
        const grams = parseFloat(transaction.grams);

        // --- IDEMPOTENCY CHECK ---
        if (transaction.status === 'completed') {
            console.log(`[Verify Payment] Transaction ${transaction.id} already COMPLETED. Skipping update.`);
            await connection.rollback(); // Rollback lock
            try { await connection.release(); console.log("[Verify Payment] DB Connection Released (Already Completed)."); } catch(e){}
            connection = null; // Prevent release in finally block
            return res.json({ // Return success, indicating previous completion
                message: 'Payment previously verified.',
                gramsAdded: grams,
                amountPaid: parseFloat(transaction.amount_inr),
            });
        }
        // Check if PENDING (If it's failed/rejected, we don't proceed with success logic)
        if (transaction.status !== 'pending') {
            console.warn(`[Verify Payment] Transaction ${transaction.id} status is ${transaction.status}. Cannot process as PENDING.`);
            await connection.rollback();
            try { await connection.release(); console.log("[Verify Payment] DB Connection Released (Not Pending)."); } catch(e){}
            connection = null;
            return res.status(409).json({ message: `Transaction status is ${transaction.status}. Cannot process.` });
        }
        // --- END IDEMPOTENCY CHECK ---


        // --- 3. EXECUTE UPDATE (Only if status is PENDING) ---
        if (isNaN(grams) || grams <= 0) {
              await connection.rollback(); // Rollback before throwing
              throw new Error(`Invalid grams (${grams}) in pending transaction ID ${transaction.id}.`);
        }
        console.log(`[Verify Payment] Found Pending Transaction ID: ${transaction.id}, Grams: ${grams}. Proceeding with updates.`);


        try { // Inner try for DB updates
            // 3. Update transaction status
            console.log(`[Verify Payment] Updating Transaction ${transaction.id} to 'completed'. CF Payment ID: ${order.cf_order_id}`);
            await connection.query(
                `UPDATE transactions SET status = 'completed', payment_id = ? WHERE id = ?`,
                [order.cf_order_id, transaction.id]
            );

            // 4. Update user portfolio
            console.log(`[Verify Payment] Updating Portfolio for User ID: ${userId}, adding ${grams}g.`);
            await connection.query(
                `INSERT INTO portfolio (user_id, total_grams) VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE total_grams = total_grams + ?`,
                [userId, grams, grams]
            );

            // 5. Commit
            await connection.commit();
            console.log("[Verify Payment] DB Transaction Committed (Success).");

            return res.json({ // Return success after commit
              message: 'Payment verified and gold added!',
              gramsAdded: grams,
              amountPaid: order.order_amount,
            });

        } catch(dbError) {
            console.error("[Verify Payment] Error during DB update transaction:", dbError);
            await connection.rollback(); // Rollback on DB error
            throw dbError; // Re-throw to be caught by outer catch
        }

    } else if (terminalFailureStatuses.includes(cashfreeStatus)) {
        // --- FAILURE PATH ---
        console.warn(`[Verify Payment] Payment has terminal failure status: ${cashfreeStatus}`);
        connection = await db.getConnection();
        await connection.beginTransaction();
        console.log("[Verify Payment] DB Transaction Started (Failure Path).");

        // Find the PENDING transaction to update it to failed
        const [pendingRows] = await connection.query<RowDataPacket[]>(
            'SELECT * FROM transactions WHERE cashfree_order_id = ? AND user_id = ? AND status = ? LIMIT 1',
            [order_id, userId, 'pending']
        );

        if (pendingRows.length > 0) {
            const transactionId = pendingRows[0].id;
            console.log(`[Verify Payment] Updating Transaction ${transactionId} status to 'failed'.`);
            await connection.query(
                `UPDATE transactions SET status = 'failed', payment_id = ? WHERE id = ?`,
                [order.cf_order_id || null, transactionId] // Store CF ID if available even on failure
            );
            await connection.commit();
            console.log("[Verify Payment] DB Transaction Committed (Failure).");
        } else {
            console.log(`[Verify Payment] No pending transaction found for OrderID ${order_id} to mark as failed. It might be completed or non-existent.`);
            await connection.rollback(); // No changes needed
        }

        // Release connection early since we are returning
        try { await connection.release(); console.log("[Verify Payment] DB Connection Released (Failure)."); } catch(e){}
        connection = null;
        // Return error to frontend
        return res.status(400).json({ message: `Payment ${cashfreeStatus.toLowerCase()}` });

    } else {
        // --- INDETERMINATE PATH (ACTIVE, PENDING, etc.) ---
        console.log(`[Verify Payment] Payment status is indeterminate: ${cashfreeStatus}. No DB update.`);
        // Release connection early since we are returning
        try { await connection.release(); console.log("[Verify Payment] DB Connection Released (Indeterminate)."); } catch(e){}
        connection = null;
        // Don't update the DB, just inform the frontend
        return res.status(400).json({ message: `Payment status is currently ${cashfreeStatus.toLowerCase()}. Please check again later.` });
    }

  } catch (error: any) {
    // Outer catch handles errors from Cashfree fetch, initial DB checks, or re-thrown DB errors
    if (connection) { // Rollback if transaction was started but failed before commit/rollback in outer scope
        try { await connection.rollback(); console.log("[Verify Payment] Rolling back DB Transaction due to outer error."); }
        catch (rbError) { console.error("Rollback failed:", rbError); }
    }
    const errorMessage = error.response?.data?.message || error.message || 'Unknown server error';
    const errorDetails = error.response?.data || error;
    console.error('[Verify Payment] Overall Error:', errorMessage, 'Details:', JSON.stringify(errorDetails, null, 2));
    res.status(500).json({ message: `Server error during payment verification: ${errorMessage}`, error: errorDetails });
  } finally {
    if (connection) { // Ensure connection is released if it hasn't been already
        try { await connection.release(); } catch (releaseError) { console.error("Release failed:", releaseError);}
        console.log("[Verify Payment] DB Connection Released.");
    }
  }
});


export default router;