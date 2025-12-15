const express = require('express');
const router = express.Router();
const notificationsController = require('../controllers/notificationsController');
const { authMiddleware } = require('../middleware/auth');

router.get('/', notificationsController.getNotifications);
// marking as read requires authentication
router.put('/:id/read', authMiddleware, notificationsController.markAsRead);

module.exports = router;
