const express = require('express');
const upload = require('../middleware/uploadMiddleware');
const uploadController = require('../controllers/uploadController');

const router = express.Router();

// POST /api/uploads/pdf - admin only (controller will check req.user if needed)
router.post('/pdf', upload.single('file'), uploadController.uploadPdf);

module.exports = router;
