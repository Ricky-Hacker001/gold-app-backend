import { Router, Request, Response } from 'express';
import bodyParser from 'body-parser';
import db from '../db';
import { RowDataPacket } from 'mysql2';

// --- Import Cashfree (Ensure correct import based on previous steps) ---
// Using require and destructure the Class
const { Cashfree } = require('cashfree-pg');
// --- End Import ---

const router = Router();

// --- Middleware to get RAW body for signature verification ---
// IMPORTANT: Apply this *only* to the webhook route, BEFORE express.json() if used globally
const rawBodySaver = (req: Request, res: Response, buf: Buffer, encoding: BufferEncoding) => {
    if (buf && buf.length) {
        (req as any).rawBody = buf.toString(encoding || 'utf8');
         console.log("[Webhook Raw Body Saver] Raw body captured, length:", (req as any).rawBody.length); // Log capture
    } else {
         console.log("[Webhook Raw Body Saver] Buffer empty or undefined.");
    }
};
// --- End Middleware ---


/**
 * @route   POST /api/webhooks/cashfree
 * @desc    Handle incoming webhook notifications from Cashfree
 * @access  Public (but verified via signature)
 */
router.post(
    '/cashfree',
    bodyParser.raw({ verify: rawBodySaver, type: '*/*' }), // Capture raw body
    async (req: Request, res: Response) => {
        console.log("[Webhook] Received Cashfree Webhook Request");

        // --- 1. Log and Verify Signature ---
        const receivedSignature = req.headers['x-webhook-signature'] as string;
        const timestamp = req.headers['x-webhook-timestamp'] as string;
        const rawBody = (req as any).rawBody;
        const secret = process.env.CASHFREE_WEBHOOK_SECRET;

        // --- ADD DETAILED LOGGING ---
        console.log("[Webhook Verification] Headers:", JSON.stringify(req.headers, null, 2));
        console.log("[Webhook Verification] x-webhook-signature:", receivedSignature);
        console.log("[Webhook Verification] x-webhook-timestamp:", timestamp);
        console.log("[Webhook Verification] rawBody type:", typeof rawBody);
        console.log("[Webhook Verification] rawBody length:", rawBody?.length);
        // console.log("[Webhook Verification] rawBody content:", rawBody); // Be cautious logging full body if sensitive
        console.log("[Webhook Verification] CASHFREE_WEBHOOK_SECRET loaded:", secret ? 'Yes' : 'No');
        // --- END LOGGING ---


        if (!receivedSignature || !timestamp || !rawBody || !secret) {
            console.error("[Webhook] Verification failed: Missing headers, body, or secret.");
             // Log exactly which ones are missing
             if (!receivedSignature) console.error(" - Missing signature header");
             if (!timestamp) console.error(" - Missing timestamp header");
             if (!rawBody) console.error(" - Missing rawBody");
             if (!secret) console.error(" - Missing webhook secret in .env");
            return res.status(400).send('Webhook verification headers/body/secret missing.');
        }

        try {
            console.log("[Webhook] Attempting signature verification...");
            // Use the static method for verification as per docs
            if (typeof Cashfree.PGVerifyWebhookSignature !== 'function') {
               console.error("Cashfree.PGVerifyWebhookSignature method not found!");
               throw new Error('Webhook verification function not available.');
            }
            Cashfree.PGVerifyWebhookSignature(receivedSignature, rawBody, timestamp); // Pass secret from env
            console.log("[Webhook] Signature Verified Successfully.");

        } catch (err: any) {
            console.error("[Webhook] Signature Verification Failed:", err.message);
            return res.status(401).send('Webhook signature verification failed.');
        }

        // --- 2. Process Verified Webhook Data ---
        let connection;
        try {
            const parsedBody = JSON.parse(rawBody); // Parse the verified raw body
            const data = parsedBody.data; // Access the nested 'data' object
            const cashfreeOrderId = data?.order?.order_id; // Your order_id
            const cashfreeCfOrderId = data?.payment?.cf_payment_id; // Cashfree's internal ID
            const status = data?.order?.order_status; // e.g., PAID, FAILED, ACTIVE, EXPIRED, CANCELLED

            console.log(`[Webhook] Processing Order ID: ${cashfreeOrderId}, Status: ${status}`);

            if (!cashfreeOrderId || !status) {
                console.warn("[Webhook] Missing order_id or status in webhook data object.");
                return res.status(400).send('Invalid webhook payload data.');
            }

            const terminalFailureStatuses = ['FAILED', 'EXPIRED', 'CANCELLED'];

            connection = await db.getConnection();
            await connection.beginTransaction();
            console.log("[Webhook] DB Transaction Started.");

            // Find the transaction by *our* order ID (cashfree_order_id)
            const [rows] = await connection.query<RowDataPacket[]>(
                'SELECT * FROM transactions WHERE cashfree_order_id = ? LIMIT 1',
                [cashfreeOrderId]
            );

            if (rows.length === 0) {
                console.warn(`[Webhook] Transaction not found for Order ID: ${cashfreeOrderId}. Ignoring.`);
                await connection.rollback(); // No transaction to process
                // Still send 200 OK so Cashfree doesn't retry indefinitely for non-existent orders
                return res.status(200).send('Transaction not found, webhook ignored.');
            }

            const transaction = rows[0];
            const currentStatus = transaction.status;

            console.log(`[Webhook] Found Transaction ID: ${transaction.id}, Current Status: ${currentStatus}`);

            // --- Idempotency Check & Status Update ---
            if (currentStatus === 'completed' || currentStatus === 'failed') {
                console.log(`[Webhook] Transaction ${transaction.id} already in terminal state (${currentStatus}). Ignoring webhook.`);
                await connection.rollback(); // No update needed

            } else if (status === 'PAID') {
                 console.log(`[Webhook] Status is PAID. Updating transaction ${transaction.id} to 'completed'.`);
                 const grams = parseFloat(transaction.grams);
                 if (isNaN(grams) || grams <= 0) {
                     await connection.rollback(); // Rollback before throwing
                     throw new Error(`Invalid grams (${grams}) in transaction ${transaction.id}`);
                 }
                 // Update transaction
                 await connection.query( `UPDATE transactions SET status = 'completed', payment_id = ? WHERE id = ?`, [cashfreeCfOrderId || transaction.payment_id, transaction.id] );
                 // Update portfolio
                 await connection.query( `INSERT INTO portfolio (user_id, total_grams) VALUES (?, ?) ON DUPLICATE KEY UPDATE total_grams = total_grams + ?`, [transaction.user_id, grams, grams] );
                 await connection.commit();
                 console.log(`[Webhook] Transaction ${transaction.id} completed and portfolio updated via webhook.`);


            } else if (terminalFailureStatuses.includes(status)) {
                 // --- Logic for FAILED status ---
                 console.log(`[Webhook] Status is ${status}. Updating transaction ${transaction.id} to 'failed'.`);
                 await connection.query(
                     `UPDATE transactions SET status = 'failed', payment_id = ? WHERE id = ?`,
                      [cashfreeCfOrderId || transaction.payment_id, transaction.id]
                 );
                 await connection.commit();
                 console.log(`[Webhook] Transaction ${transaction.id} marked as failed via webhook.`);
                 // --- End Logic for FAILED ---

            } else {
                console.log(`[Webhook] Received non-terminal status '${status}'. No DB update performed.`);
                await connection.rollback(); // No change needed for statuses like ACTIVE
            }

            // Send 200 OK to acknowledge receipt
            res.status(200).send('Webhook processed.');

        } catch (error: any) {
            if (connection) {
                console.log("[Webhook] Rolling back DB Transaction due to processing error.");
                await connection.rollback();
            }
            const errorMessage = error.message || 'Unknown processing error';
            console.error('[Webhook] Processing Error:', errorMessage, error);
            // Send 500 so Cashfree might retry, but be cautious about infinite loops
            res.status(500).send(`Webhook processing error: ${errorMessage}`);
        } finally {
            if (connection) {
                try { await connection.release(); } catch(e){}
                 console.log("[Webhook] DB Connection Released.");
            }
        }
    }
);

export default router;