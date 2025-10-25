import { Cashfree } from 'cashfree-pg';

// Create and export a configured instance of the SDK
export const cashfree = new Cashfree({
  env: 'SANDBOX', // 'SANDBOX' or 'PRODUCTION'
  api_version: '2023-08-01',
  appId: process.env.CASHFREE_APP_ID || '',
  secretKey: process.env.CASHFREE_SECRET_KEY || '',
});