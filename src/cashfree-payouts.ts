import dotenv from 'dotenv';
dotenv.config();

// --- START CASHFREE IMPORT & CONFIG ---
// Use require and destructure the main class
const { Cashfree } = require("cashfree-payout");

// Get the credentials from environment variables
const PAYOUTS_CLIENT_ID = process.env.CF_PO_CLIENT_ID || '';
const PAYOUTS_SECRET_KEY = process.env.CF_PO_CLIENT_SECRET || '';

// Determine the environment argument (handle potential missing Environment enum)
// NOTE: We assume Cashfree.Environment exists if Cashfree.SANDBOX exists
const environment = (Cashfree.Environment && Cashfree.Environment.SANDBOX) 
    ? Cashfree.Environment.SANDBOX 
    : (Cashfree.SANDBOX || 'https://payout-sandbox.cashfree.com'); 

// Create and export a configured Payouts instance (The static Cashfree class itself)
if (!PAYOUTS_CLIENT_ID || !PAYOUTS_SECRET_KEY) {
    console.warn("!!! CASHFREE PAYOUTS WARNING: Client ID or Secret is missing. Payouts will fail. !!!");
}

try {
    // 1. Set static credentials (v < 5 style)
    Cashfree.XClientId = PAYOUTS_CLIENT_ID;
    Cashfree.XClientSecret = PAYOUTS_SECRET_KEY;
    Cashfree.XEnvironment = environment; // Set environment

    console.log("Cashfree Payouts SDK Configured Statically.");
} catch (e: any) {
    console.error("!!! FATAL: Failed to configure Cashfree Payouts SDK statically !!!", e);
    throw new Error("Payouts SDK Configuration Error.");
}

// Export the configured static Cashfree class. 
// We expect the methods (like Payouts.initiateTransfer) to be called directly on this object.
export const cashfreePayouts = Cashfree;