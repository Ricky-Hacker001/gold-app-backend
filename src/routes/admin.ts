import { Router } from 'express';
import db from '../db';
import { authMiddleware, adminMiddleware, AuthRequest } from '../middleware/authMiddleware';
import { RowDataPacket } from 'mysql2';

const router = Router();

// Helper to get current price
const getCurrentGoldPrice = async (): Promise<number> => {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT setting_value FROM app_settings WHERE setting_key = 'current_gold_price'"
  );
  if (rows.length === 0) return 0;
  return parseFloat(rows[0].setting_value);
};

// --- UPDATE GOLD PRICE (Admin Only) ---
router.post('/price', authMiddleware, adminMiddleware, async (req, res) => {
  const { newPrice } = req.body;
  if (!newPrice || isNaN(parseFloat(newPrice))) {
    return res.status(400).json({ message: 'Invalid price' });
  }
  try {
    // 1. Update current price
    await db.query(
      "UPDATE app_settings SET setting_value = ? WHERE setting_key = 'current_gold_price'",
      [newPrice]
    );
    // 2. Update/Insert today's history
    await db.query(
      `INSERT INTO price_history (price_date, price_value)
       VALUES (CURDATE(), ?)
       ON DUPLICATE KEY UPDATE price_value = ?`,
      [newPrice, newPrice]
    );
    res.json({ message: 'Gold price updated successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// --- GET ALL USERS WITH PORTFOLIO (Admin Only) ---
router.get('/users-portfolio', authMiddleware, adminMiddleware, async (req: AuthRequest, res) => {
  try {
    const pricePerGram = await getCurrentGoldPrice();

    const [users] = await db.query<RowDataPacket[]>(
      `SELECT 
         u.id, u.name, u.email, u.phone,
         COALESCE(p.total_grams, 0) AS totalGrams,
         COALESCE(t.totalInvested, 0) AS totalInvested
       FROM users u
       LEFT JOIN portfolio p ON u.id = p.user_id
       LEFT JOIN (
         SELECT user_id, SUM(amount_inr) as totalInvested 
         FROM transactions 
         WHERE type = 'buy' AND status = 'completed' 
         GROUP BY user_id
       ) t ON u.id = t.user_id
       WHERE u.role = 'user'
       ORDER BY u.name`
    );

    const usersWithCalculations = users.map(user => {
      const currentValue = parseFloat(user.totalGrams as string) * pricePerGram;
      const profit = currentValue - parseFloat(user.totalInvested as string);
      return {
        ...user,
        currentValue,
        profit
      };
    });

    res.json(usersWithCalculations);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// --- GET ALL ADMINS (Admin Only) ---
router.get('/admins', authMiddleware, adminMiddleware, async (req: AuthRequest, res) => {
  try {
    const [rows] = await db.query<RowDataPacket[]>(
      "SELECT id, name, email, phone, created_at FROM users WHERE role = 'admin' ORDER BY name"
    );
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// --- PROMOTE A USER TO ADMIN (Admin Only) ---
router.post('/promote-admin', authMiddleware, adminMiddleware, async (req: AuthRequest, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ message: 'Email is required' });
  }

  try {
    const [users] = await db.query<RowDataPacket[]>(
      'SELECT * FROM users WHERE email = ?',
      [email]
    );
    if (users.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }
    if (users[0].role === 'admin') {
      return res.status(409).json({ message: 'User is already an admin' });
    }

    await db.query("UPDATE users SET role = 'admin' WHERE email = ?", [email]);
    res.json({ message: `User ${email} has been promoted to admin` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// --- (THIS WAS MISSING) GET ALL TRANSACTIONS (Admin Only) ---
router.get('/transactions', authMiddleware, adminMiddleware, async (req: AuthRequest, res) => {
  try {
    // Join with users table to get user name/email
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT t.id, t.type, t.status, t.amount_inr, t.grams, t.created_at, u.name, u.email 
       FROM transactions t
       JOIN users u ON t.user_id = u.id
       ORDER BY t.created_at DESC`
    );
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});
// --- END OF MISSING ROUTE ---

export default router;