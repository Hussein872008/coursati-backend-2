const express = require('express');

const treeController = require('../controllers/treeController');
const { authMiddleware, checkSubscription } = require('../middleware/auth');

const router = express.Router();

// Protected route to get full content tree (require active subscription)
router.get('/', authMiddleware, checkSubscription, treeController.getContentTree);

module.exports = router;