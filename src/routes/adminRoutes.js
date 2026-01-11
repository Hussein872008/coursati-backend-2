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

// Video status admin actions
const videoStatusController = require('../controllers/videoStatusController');
router.post('/videos/:videoId/recheck', authMiddleware, adminMiddleware, videoStatusController.recheckVideo);
router.post('/lectures/:lectureId/recheck', authMiddleware, adminMiddleware, videoStatusController.recheckLecture);
router.get('/lectures/:lectureId/notify-debug', authMiddleware, adminMiddleware, videoStatusController.getLectureNotifyDebug);
// Admin: video status summary
router.get('/videos/status-summary', authMiddleware, adminMiddleware, adminController.getVideoStatusSummary);

// Removed video status history and probe metrics endpoints to reduce stored logs

// Admin: (legacy validation endpoints removed)

// Lecture health and validation endpoints removed; a new validator service will be added later.

// Admin: get lecture by id (no subscription check) - used by admin UI redirects
const lectureController = require('../controllers/lectureController');
router.get('/lectures/:id', authMiddleware, adminMiddleware, lectureController.getLectureById);

// Validation endpoints removed from admin API.
// Admin: list all videos for dashboard
router.get('/videos', authMiddleware, adminMiddleware, videoController.getAllVideosAdmin);
// All validation-job routes removed.
// Admin: update video metadata
router.put('/videos/:videoId', authMiddleware, adminMiddleware, videoController.updateVideo);
// Admin: manual override removed — will be part of new validator UI/service.
module.exports = router;
