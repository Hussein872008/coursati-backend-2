const express = require('express');
const lectureController = require('../controllers/lectureController');
const { adminMiddleware, authMiddleware, checkSubscription } = require('../middleware/auth');
const upload = require('../middleware/uploadMiddleware');

const router = express.Router();

// Admin only routes
router.post('/', adminMiddleware, upload.single('thumbnail'), lectureController.createLecture);
router.put('/:id', adminMiddleware, upload.single('thumbnail'), lectureController.updateLecture);
router.delete('/:id', adminMiddleware, lectureController.deleteLecture);

// Protected routes: require valid user code and active subscription
router.get('/chapter/:chapterId', authMiddleware, checkSubscription, lectureController.getLecturesByChapter);
router.get('/:id', authMiddleware, checkSubscription, lectureController.getLectureById);
// Admin: get viewers for a lecture
router.get('/:id/viewers', authMiddleware, adminMiddleware, lectureController.getLectureViewers);
// Record a view for the lecture (protected)
router.post('/:id/view', authMiddleware, checkSubscription, lectureController.recordLectureView);

module.exports = router;
