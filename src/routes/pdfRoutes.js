const express = require('express');
const pdfController = require('../controllers/pdfController');
const { adminMiddleware, authMiddleware, optionalAuth, checkSubscription } = require('../middleware/auth');
const upload = require('../middleware/uploadMiddleware');

const router = express.Router();

// Admin only routes (require auth then admin check)
router.post('/', authMiddleware, adminMiddleware, upload.single('file'), pdfController.createPDF);
router.put('/:id', authMiddleware, adminMiddleware, upload.single('file'), pdfController.updatePDF);
router.delete('/:id', authMiddleware, adminMiddleware, pdfController.deletePDF);

// Admin: get viewers list for a PDF
router.get('/:id/viewers', authMiddleware, adminMiddleware, pdfController.getPDFViewers);

// Protected routes: require valid user code and active subscription
router.get('/lecture/:lectureId', authMiddleware, checkSubscription, pdfController.getPDFsByLecture);
router.get('/:id', authMiddleware, checkSubscription, pdfController.getPDFById);
// Record view (requires active subscription)
router.post('/:id/view', authMiddleware, checkSubscription, pdfController.viewPDF);

module.exports = router;
