import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/auth';
import goldRoutes from './routes/gold';   // <-- ADD
import adminRoutes from './routes/admin'; // <-- ADD
import buyRoutes from './routes/buy';
import portfolioRoutes from './routes/portfolio'; 
import transactionRoutes from './routes/transactions';
// import './cashfree';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/gold', goldRoutes);   // <-- ADD
app.use('/api/admin', adminRoutes); // <-- ADD
app.use('/api/buy', buyRoutes);
app.use('/api/portfolio', portfolioRoutes); 
app.use('/api/transactions', transactionRoutes);

// Start the server
app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});