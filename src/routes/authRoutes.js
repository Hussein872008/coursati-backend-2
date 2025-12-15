const express = require('express');
const authController = require('../controllers/authController');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

const router = express.Router();

// Public auth routes
router.post('/admin-login', authController.adminLogin);
router.post('/user-login', authController.userLogin);

// Admin only routes (require authMiddleware + adminMiddleware)
router.post('/create-user', authMiddleware, adminMiddleware, authController.createUser);
router.get('/users', authMiddleware, adminMiddleware, authController.getAllUsers);
router.get('/users/:id', authMiddleware, adminMiddleware, authController.getUserById);
router.get('/users/:id/history', authMiddleware, adminMiddleware, authController.getUserHistory);
router.put('/users/:id', authMiddleware, adminMiddleware, authController.updateUser);
router.put('/users/:id/subscription', authMiddleware, adminMiddleware, authController.updateSubscription);
router.delete('/users/:id', authMiddleware, adminMiddleware, authController.deleteUser);

// Reset deviceId for a user (admin only)
router.put('/users/:id/reset-device', authMiddleware, adminMiddleware, authController.resetDevice);

module.exports = router;
