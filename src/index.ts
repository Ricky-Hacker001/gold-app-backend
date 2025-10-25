// --- 1. MOVE THIS TO THE TOP ---
import dotenv from 'dotenv';
dotenv.config();
// --- END OF FIX ---

import express from 'express';
import cors from 'cors';
import authRoutes from './routes/auth';
import goldRoutes from './routes/gold';
import adminRoutes from './routes/admin';
import buyRoutes from './routes/buy';
import portfolioRoutes from './routes/portfolio';
import transactionRoutes from './routes/transactions';

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json()); 

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/gold', goldRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/buy', buyRoutes);
app.use('/api/portfolio', portfolioRoutes);
app.use('/api/transactions', transactionRoutes);

// Start the server
app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});