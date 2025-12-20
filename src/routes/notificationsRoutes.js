const express = require('express');
const router = express.Router();
const notificationsController = require('../controllers/notificationsController');
const { authMiddleware } = require('../middleware/auth');

router.get('/', notificationsController.getNotifications);
// marking as read requires authentication
router.put('/:id/read', authMiddleware, notificationsController.markAsRead);
// mark all as read
router.put('/read-all', authMiddleware, notificationsController.markAllRead);

module.exports = router;
