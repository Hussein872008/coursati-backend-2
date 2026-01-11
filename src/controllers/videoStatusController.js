const Video = require('../models/Video');
const { checkSingleVideo, checkLectureVideos } = require('../services/videoStatusService');
const { getRecoveryRecipientsForLecture } = require('../services/videoStatusService');

// GET /api/videos/lecture/:lectureId/availability
exports.getLectureAvailability = async (req, res) => {
  try {
    const { lectureId } = req.params;
    // summary from DB
    const videos = await Video.find({ lectureId }).lean();
    const perVideo = {};
    let total = 0, broken = 0, working = 0, unknown = 0;
    for (const v of videos) {
      total += 1;
      const st = v.status || 'unknown';
      perVideo[String(v._id)] = st;
      if (st === 'broken') broken += 1;
      else if (st === 'working') working += 1;
      else unknown += 1;
    }
    return res.json({ ok: true, total, broken, working, unknown, perVideo });
  } catch (err) {
    console.error('getLectureAvailability error', err);
    return res.status(500).json({ message: err.message });
  }
};

// POST /api/admin/videos/:videoId/recheck
exports.recheckVideo = async (req, res) => {
  try {
    const { videoId } = req.params;
    const video = await Video.findById(videoId);
    if (!video) return res.status(404).json({ message: 'video not found' });
    const result = await checkSingleVideo(video);
    return res.json({ ok: true, result });
  } catch (err) {
    console.error('recheckVideo error', err);
    return res.status(500).json({ message: err.message });
  }
};

// POST /api/admin/lectures/:lectureId/recheck
exports.recheckLecture = async (req, res) => {
  try {
    const { lectureId } = req.params;
    const result = await checkLectureVideos(lectureId);
    return res.json(result);
  } catch (err) {
    console.error('recheckLecture error', err);
    return res.status(500).json({ message: err.message });
  }
};

// GET /api/admin/lectures/:lectureId/notify-debug
exports.getLectureNotifyDebug = async (req, res) => {
  try {
    const { lectureId } = req.params;
    const recipients = await getRecoveryRecipientsForLecture(lectureId);
    return res.json({ ok: true, recipients });
  } catch (err) {
    console.error('getLectureNotifyDebug error', err);
    return res.status(500).json({ message: err.message });
  }
};

module.exports = exports;
