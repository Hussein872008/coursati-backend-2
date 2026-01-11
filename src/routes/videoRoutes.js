const express = require('express');
const videoController = require('../controllers/videoController');
const { authMiddleware, optionalAuth, adminMiddleware, checkSubscription } = require('../middleware/auth');

const router = express.Router();

// Protected: get videos by lecture (require active subscription)
router.get('/lecture/:lectureId', authMiddleware, checkSubscription, videoController.getVideosByLecture);
// Lightweight availability summary (public read, no playback blocking)
const videoStatusController = require('../controllers/videoStatusController');
router.get('/lecture/:lectureId/availability', videoStatusController.getLectureAvailability);

// Playlist (m3u8) for a given quality (signed segment URLs inside)
// Require a valid user code and active subscription so playlists aren't accessible for expired codes
router.get('/:videoId/playlist/:quality.m3u8', videoController.playlist);

// Admin: list viewers for a video
router.get('/:videoId/viewers', authMiddleware, adminMiddleware, videoController.getVideoViewers);
// Admin: delete a video
router.delete('/:videoId', authMiddleware, adminMiddleware, videoController.deleteVideo);
// Admin: request a revalidation for a video (removed)
// Admin: update video metadata (title, duration)
router.put('/:videoId', authMiddleware, adminMiddleware, videoController.updateVideo);
// Validation endpoints removed. Replaced by new validator service later.
// Record a view for a specific video (requires subscription)
router.post('/:videoId/view', authMiddleware, checkSubscription, videoController.recordVideoView);
// Download assembled file (streams segments sequentially). Requires active session/subscription and download permission.
router.get('/:videoId/download', authMiddleware, checkSubscription, videoController.download);

// Proxy a segment using direct URL
router.get('/:videoId/segments/:quality/:segmentNumber', videoController.proxySegment);

module.exports = router;
