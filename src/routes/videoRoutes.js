const express = require('express');
const videoController = require('../controllers/videoController');
const { authMiddleware, optionalAuth, adminMiddleware, checkSubscription } = require('../middleware/auth');

const router = express.Router();

// Protected: get videos by lecture (require active subscription)
router.get('/lecture/:lectureId', authMiddleware, checkSubscription, videoController.getVideosByLecture);

// Playlist (m3u8) for a given quality (signed segment URLs inside)
// Require a valid user code and active subscription so playlists aren't accessible for expired codes
router.get('/:videoId/playlist/:quality.m3u8', authMiddleware, checkSubscription, videoController.playlist);

// Admin: list viewers for a video
router.get('/:videoId/viewers', authMiddleware, adminMiddleware, videoController.getVideoViewers);
// Admin: delete a video
router.delete('/:videoId', authMiddleware, adminMiddleware, videoController.deleteVideo);
// Record a view for a specific video (requires subscription)
router.post('/:videoId/view', authMiddleware, checkSubscription, videoController.recordVideoView);

// Download assembled file (streams segments sequentially). Requires active session/subscription and download permission.
router.get('/:videoId/download', authMiddleware, checkSubscription, videoController.download);

// Sign a segment (requires auth + active subscription)
router.post('/:videoId/sign', authMiddleware, checkSubscription, videoController.signSegment);

// Proxy a segment using token (no auth required but token is verified)
router.get('/:videoId/segments/:quality/:segmentNumber', videoController.proxySegment);

module.exports = router;
