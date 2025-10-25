import { Router } from 'express';
import db from '../db';
import { authMiddleware, AuthRequest } from '../middleware/authMiddleware';
import { RowDataPacket } from 'mysql2';

const router = Router();

/**
 * @route   GET /api/transactions/my
 * @desc    Get current user's transaction history
 * @access  Private
 */
router.get('/my', authMiddleware, async (req: AuthRequest, res) => {
  const userId = req.user?.userId;
  try {
    const [rows] = await db.query<RowDataPacket[]>(
      'SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;