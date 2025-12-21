const express = require('express');
const adminController = require('../controllers/adminController');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

const router = express.Router();

// Protected admin routes
router.get('/stats', authMiddleware, adminMiddleware, adminController.getStats);
router.get('/activity', authMiddleware, adminMiddleware, adminController.getActivity);
router.get('/stats/timeseries', authMiddleware, adminMiddleware, adminController.getTimeSeries);

// Admin: create video for a lecture
const videoController = require('../controllers/videoController');
router.post('/lectures/:lectureId/videos', authMiddleware, adminMiddleware, videoController.createVideo);

// Admin: validate or mirror segments for a video
router.post('/videos/:videoId/validate', authMiddleware, adminMiddleware, videoController.validateVideo);
// Admin: update video metadata
router.put('/videos/:videoId', authMiddleware, adminMiddleware, videoController.updateVideo);
module.exports = router;
