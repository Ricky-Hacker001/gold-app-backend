import { Cashfree, CFEnvironment } from "cashfree-pg";
import axios from "axios";

// Load ENV
const APP_ID = process.env.CASHFREE_APP_ID;
const SECRET_KEY = process.env.CASHFREE_SECRET_KEY;
const ENV_MODE = process.env.CASHFREE_ENV || "PROD"; // or SANDBOX

if (!APP_ID || !SECRET_KEY) {
  console.error("❌ Missing Cashfree ENV variables!");
  process.exit(1);
}

// Determine Environment
const CF_ENV = ENV_MODE === "SANDBOX"
  ? CFEnvironment.SANDBOX
  : CFEnvironment.PRODUCTION;

// Create SDK Instance
export const cashfreeInstance = new Cashfree(
  CF_ENV,
  APP_ID,
  SECRET_KEY
);

// ✅ Wrapper with Retry Logic
async function retry(fn: Function, retries = 2) {
  try {
    return await fn();
  } catch (err: any) {
    if (retries === 0) throw err;
    console.warn("⚠️ Cashfree retry due to error:", err.message);
    return retry(fn, retries - 1);
  }
}

// ✅ Order Creation Wrapper
export const createOrder = async (orderPayload: any) => {
  return retry(() => cashfreeInstance.PGCreateOrder(orderPayload));
};

// ✅ Order Fetch Wrapper
export const fetchOrder = async (orderId: string) => {
  return retry(() => cashfreeInstance.PGFetchOrder(orderId));
};

// Debug Logs (Safe)
console.log(`✅ Cashfree initialized in ${ENV_MODE} mode`);
