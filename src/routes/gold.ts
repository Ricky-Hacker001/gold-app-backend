import { Router } from 'express';
import db from '../db';
import { RowDataPacket } from 'mysql2';

const router = Router();

// --- GET CURRENT GOLD PRICE (Public) ---
router.get('/price', async (req, res) => {
  try {
    const [rows] = await db.query<RowDataPacket[]>(
      "SELECT setting_value FROM app_settings WHERE setting_key = 'current_gold_price'"
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: 'Gold price not set' });
    }

    res.json({ price: parseFloat(rows[0].setting_value) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// --- NEW: GET PRICE HISTORY FOR CHART (Public) ---
router.get('/history', async (req, res) => {
  try {
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT 
         price_date, 
         price_value 
       FROM price_history 
       ORDER BY price_date DESC 
       LIMIT 7` // Get the last 7 entries
    );
    
    // Reverse the data so it's in chronological order for the chart
    const formattedData = rows.reverse().map((row: any) => ({
      // Format the date to be more readable (e.g., "Oct 24")
      name: new Date(row.price_date).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      }),
      price: parseFloat(row.price_value),
    }));

    res.json(formattedData);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;