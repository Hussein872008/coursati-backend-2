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

// Admin: get lecture by id (no subscription check) - used by admin UI redirects
const lectureController = require('../controllers/lectureController');
router.get('/lectures/:id', authMiddleware, adminMiddleware, lectureController.getLectureById);

// Admin: validate or mirror segments for a video
router.post('/videos/:videoId/validate', authMiddleware, adminMiddleware, videoController.validateVideo);
// Admin: validate all videos (runs per-video validation sequentially)
router.post('/videos/validate-all', authMiddleware, adminMiddleware, videoController.startValidateAllVideos);
// Ensure the explicit `/latest` route is registered before the `:jobId` param
router.get('/videos/validate-all/latest', authMiddleware, adminMiddleware, videoController.getLatestValidateJob);
router.get('/videos/validate-all/:jobId', authMiddleware, adminMiddleware, videoController.getValidateJob);
// Admin: list all videos for dashboard
router.get('/videos', authMiddleware, adminMiddleware, videoController.getAllVideosAdmin);
// Pause/resume a validation job
router.post('/videos/validate-all/:jobId/pause', authMiddleware, adminMiddleware, videoController.pauseValidateJob);
router.post('/videos/validate-all/:jobId/resume', authMiddleware, adminMiddleware, videoController.resumeValidateJob);
// Delete a validation job
router.delete('/videos/validate-all/:jobId', authMiddleware, adminMiddleware, videoController.deleteValidateJob);
// Revalidate a specific video and append result to job ("jump to failed")
router.post('/videos/validate-all/:jobId/revalidate/:videoId', authMiddleware, adminMiddleware, videoController.revalidateJobVideo);
// Stop a validation job
router.post('/videos/validate-all/:jobId/stop', authMiddleware, adminMiddleware, videoController.stopValidateJob);
// List recent validation jobs
router.get('/videos/validate-all/jobs', authMiddleware, adminMiddleware, videoController.listValidateJobs);
// Admin: update video metadata
router.put('/videos/:videoId', authMiddleware, adminMiddleware, videoController.updateVideo);
module.exports = router;
