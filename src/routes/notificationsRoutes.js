const express = require('express');
const router = express.Router();
const notificationsController = require('../controllers/notificationsController');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

router.get('/', notificationsController.getNotifications);
// marking as read requires authentication
router.put('/:id/read', authMiddleware, notificationsController.markAsRead);
// mark all as read
router.put('/read-all', authMiddleware, notificationsController.markAllRead);
// delete all notifications (admin only)
router.delete('/delete-all', authMiddleware, adminMiddleware, notificationsController.deleteAllNotifications);

module.exports = router;
