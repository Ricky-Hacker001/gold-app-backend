import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
dotenv.config(); // Ensure this is the very first line

// Import body-parser but don't use it globally yet
// import bodyParser from 'body-parser'; // We use it specifically in the route

import authRoutes from './routes/auth';
import goldRoutes from './routes/gold';
import adminRoutes from './routes/admin';
import buyRoutes from './routes/buy';
import portfolioRoutes from './routes/portfolio';
import transactionRoutes from './routes/transactions';
import webhookRoutes from './routes/webhooks'; // <-- IMPORT NEW ROUTE
import sellRoutes from './routes/sell';
import profileRoutes from './routes/profile';
import './cashfree-payouts';


const app = express();
const PORT = process.env.PORT || 5000;

// --- Global Middleware (Applied AFTER Webhook) ---
app.use(cors());

// --- Webhook Route (Applied BEFORE express.json) ---
// It uses its own raw body parser internally
app.use('/api/webhooks', webhookRoutes); // <-- MOUNT WEBHOOK ROUTE HERE

// --- Other Middleware (Applied AFTER Webhook) ---
app.use(express.json()); // Allows server to read JSON bodies for other routes

// --- Other Routes ---
app.use('/api/auth', authRoutes);
app.use('/api/gold', goldRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/buy', buyRoutes);
app.use('/api/portfolio', portfolioRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/sell', sellRoutes);
app.use('/api/profile', profileRoutes);

// Start the server
app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});