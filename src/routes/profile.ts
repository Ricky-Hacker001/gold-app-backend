import { Router } from 'express';
import db from '../db';
import { RowDataPacket } from 'mysql2';
import { authMiddleware, AuthRequest } from '../middleware/authMiddleware';

const router = Router();

/**
 * @route   GET /api/profile/me
 * @desc    Get current logged-in user's profile data
 * @access  Private
 */
router.get('/me', authMiddleware, async (req: AuthRequest, res) => {
    const userId = req.user?.userId;
    console.log(`[Profile Get] Fetching profile for User ID: ${userId}`);
    try {
        const [rows] = await db.query<RowDataPacket[]>(
            `SELECT id, name, email, phone, role, created_at,
                    bank_account_name, bank_account_number, bank_ifsc_code,
                    pan_card_number, aadhaar_card_number  -- <-- ADDED KYC FIELDS
             FROM users WHERE id = ?`,
            [userId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ message: 'User profile not found.' });
        }
        // Exclude password from the response
        const { password, ...profileData } = rows[0];
        res.json(profileData);

    } catch (error: any) {
        console.error("[Profile Get] Error:", error.message);
        res.status(500).json({ message: 'Server error fetching profile', error: error.message });
    }
});

/**
 * @route   PUT /api/profile/update
 * @desc    Update current logged-in user's bank and KYC details
 * @access  Private
 */
router.put('/update', authMiddleware, async (req: AuthRequest, res) => {
    const userId = req.user?.userId;
    const { accountName, accountNumber, ifscCode, panNumber, aadhaarNumber } = req.body;
    console.log(`[Profile Update] Request for User ID: ${userId}`);

    // Validation (Keep bank details mandatory for withdrawal workflow)
    if (!accountName || !accountNumber || !ifscCode) {
        return res.status(400).json({ message: 'Account name, number, and IFSC code are required.' });
    }

    try {
        await db.query(
            `UPDATE users
             SET bank_account_name = ?, 
                 bank_account_number = ?, 
                 bank_ifsc_code = ?,
                 pan_card_number = ?,       -- <-- NEW
                 aadhaar_card_number = ?    -- <-- NEW
             WHERE id = ?`,
            [
                accountName.trim(), 
                accountNumber.trim(), 
                ifscCode.trim().toUpperCase(),
                (panNumber || '').trim().toUpperCase(), // Store PAN uppercase
                (aadhaarNumber || '').trim(), // Store Aadhaar
                userId
            ]
        );
        console.log(`[Profile Update] Details updated for User ID: ${userId}`);
        res.json({ message: 'Profile details updated successfully.' });

    } catch (error: any) {
        // Catch unique constraint violations for PAN/Aadhaar
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ message: 'PAN or Aadhaar number is already registered to another account.' });
        }
        console.error("[Profile Update] Error:", error.message);
        res.status(500).json({ message: 'Server error updating profile details', error: error.message });
    }
});

export default router;