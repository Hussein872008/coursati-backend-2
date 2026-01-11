const Video = require('../models/Video');
const Lecture = require('../models/Lecture');
const Notification = require('../models/Notification');
const { probeUrl } = require('../utils/videoStatusChecker');
const { waitForTurn } = require('../utils/hostRateLimiter');
const { sendNotification } = require('../utils/notificationBus');
// Debug flag to reduce noisy logs in production
const VIDEO_STATUS_DEBUG = (() => { const v = process.env.VIDEO_STATUS_DEBUG; return v === '1' || v === 'true' || v === 'yes'; })();
function dbg(...args) { if (VIDEO_STATUS_DEBUG) console.info(...args); }

// Whether to notify all non-admin users when no enrolled recipients are found.
// Default: enabled to avoid silent recovery events for students who expect updates.
const FALLBACK_ALL_USERS = (() => {
  const v = process.env.VIDEO_NOTIFY_FALLBACK_ALL_USERS;
  if (v === undefined || v === null) return true; // default to true
  return v === '1' || v === 'true' || v === 'yes';
})();
// Maximum number of fallback recipients to allow before aborting fallback automatically
const FALLBACK_MAX = Number(process.env.VIDEO_NOTIFY_FALLBACK_MAX || '1000');
const FORCE_FALLBACK = (() => { const v = process.env.VIDEO_NOTIFY_FORCE_FALLBACK; return v === '1' || v === 'true' || v === 'yes'; })();
// ProbeMetric removed: do not persist per-probe metrics to keep DB small

// Centralized service to check video status and update DB + notifications
async function checkSingleVideo(video) {
  if (!video) return null;
  const createdNotifications = [];
  // choose a candidate URL from qualities (prefer first with lastSegmentUrl)
  const qualities = Array.isArray(video.qualities) ? video.qualities : [];
  let url = null;
  for (const q of qualities) {
    if (q && (q.lastSegmentUrl || q.url)) { url = q.lastSegmentUrl || q.url; break; }
  }
  if (!url) {
    // no known URL -> mark unknown
    const prev = video.status;
    if (prev !== 'unknown') {
      video.status = 'unknown';
      video.statusUpdatedAt = new Date();
      try { await video.save(); } catch (e) {}
    }
    return { id: video._id, status: 'unknown' };
  }

  // mark checking
  let changed = false;
  if (video.status !== 'checking') {
    video.status = 'checking';
    video.statusUpdatedAt = new Date();
    changed = true;
    try { await video.save(); } catch (e) {}
  }

  // probe URL (respect per-host rate limiter)
  const host = (() => {
    try { return new URL(url).host; } catch (e) { return null; }
  })();
  try {
    await waitForTurn(host);
  } catch (e) {
    // rate limiter errors should not stop probing
  }
  const start = Date.now();
  // keep attempts small; probes should be lightweight
  const res = await probeUrl(url, { timeout: 5000, retries: 2 });
  const durationMs = Date.now() - start;
  const newStatus = res.ok ? 'working' : 'broken';

  const prevStatus = video.status;
  if (prevStatus !== newStatus) {
    video.status = newStatus;
    video.statusUpdatedAt = new Date();
    try { await video.save(); } catch (e) {}

    // If transitioning to broken, notify admins (real-time SSE always; DB creation suppressed by recent)
    if (prevStatus === 'working' && newStatus === 'broken') {
      try {
        const lecture = await Lecture.findById(video.lectureId).select('title instructorId materialId').lean().catch(() => null);
        const payload = {
          title: `Video broken: ${video.title || 'Untitled'}`,
          body: `Lecture: ${lecture?.title || 'unknown'} — Video: ${video.title || 'untitled'}`,
          meta: { videoId: String(video._id), lectureId: String(video.lectureId), context: { materialId: lecture?.materialId, instructorId: lecture?.instructorId } },
          timestamp: new Date()
        };
        const suppressionMs = Number(process.env.VIDEO_NOTIFY_SUPPRESSION_MS || String(10 * 60 * 1000));
        const since = new Date(Date.now() - suppressionMs);
        const recent = await Notification.findOne({ adminOnly: true, 'data.videoId': String(video._id), createdAt: { $gte: since } }).exec();
        // Always send a real-time SSE to admins so connected admins get immediate notice.
        try {
          sendNotification(Object.assign({}, payload, { adminOnly: true, transient: !!recent }));
          dbg('Admin realtime notification sent for broken video', String(video._id), 'transient:', !!recent);
        } catch (e) {
          console.warn('sendNotification (admin realtime) failed', e && e.message);
        }

        // Only persist a DB notification if none recent (suppression).
        if (!recent) {
          const created = await Notification.create({ title: payload.title, body: payload.body, adminOnly: true, data: payload.meta });
          createdNotifications.push({ id: created._id, adminOnly: true, reason: 'video_broken' });
          console.info('Admin DB notification created for broken video', String(video._id), created && created._id);
        } else {
          console.info('Admin DB notification suppressed due to recent notification for video', String(video._id));
        }
      } catch (e) {
        console.warn('notifyAdmins error', e && e.message);
      }
    }

    // If transitioning to working from broken, trigger lightweight lecture-level recovery check
    if (prevStatus === 'broken' && newStatus === 'working') {
      try {
        // Check DB to see if all videos for the lecture are now 'working'
        const vids = await Video.find({ lectureId: video.lectureId }).lean().catch(() => []);
        if (Array.isArray(vids) && vids.length > 0 && vids.every((vv) => vv && vv.status === 'working')) {
          // Avoid duplicate recovery notifications by checking for recent notif for this lecture
          const suppressionMs = Number(process.env.VIDEO_NOTIFY_SUPPRESSION_MS || String(10 * 60 * 1000));
          const since = new Date(Date.now() - suppressionMs);
          const recent = await Notification.findOne({ lectureId: String(video.lectureId), createdAt: { $gte: since } }).exec();
          if (!recent) {
            // build notification similar to lecture-level flow
            const chapterModel = require('../models/Chapter');
            const instructorModel = require('../models/Instructor');
            const Enrollment = require('../models/Enrollment');
            const User = require('../models/User');

            const lectureDoc = await Lecture.findById(video.lectureId).lean().catch(() => null);
            if (lectureDoc) {
              const chapter = await chapterModel.findById(lectureDoc.chapterId).lean().catch(() => null);
              let instructor = null;
              let materialId = null;
              if (chapter && chapter.instructorId) {
                instructor = await instructorModel.findById(chapter.instructorId).lean().catch(() => null);
                if (instructor && instructor.materialId) {
                  materialId = (instructor.materialId && (instructor.materialId._id || instructor.materialId)) || null;
                }
              }
                    if (materialId) {
                      const enrolls = await Enrollment.find({ materialId: materialId }).lean().catch(() => []);
                      const userIds = Array.isArray(enrolls) ? enrolls.map((e) => e.userId).filter(Boolean) : [];
                      if (userIds.length > 0) {
                        const recipients = await User.find({ _id: { $in: userIds }, isAdmin: { $ne: true } }).select('_id').lean().catch(() => []);
                        const recIds = recipients.map((r) => r._id).filter(Boolean);
                        if (recIds.length === 0 && FALLBACK_ALL_USERS) {
                          const fallbackUsers = await User.find({ isAdmin: { $ne: true } }).select('_id').lean().catch(() => []);
                          if (!Array.isArray(fallbackUsers)) {
                            dbg('Fallback fetch returned non-array, skipping fallback (single-video)');
                          } else if (fallbackUsers.length > FALLBACK_MAX && !FORCE_FALLBACK) {
                            dbg('Fallback aborted (single-video): candidates', fallbackUsers.length, 'exceeds max', FALLBACK_MAX);
                          } else {
                            dbg('Recovery notification fallback: no enrolled non-admins, fetching all non-admin users (single-video)', fallbackUsers.length, 'candidates');
                            recIds.push(...(fallbackUsers || []).map((u) => u._id).filter(Boolean));
                          }
                        }
                        if (recIds.length > 0) {
                    const notifTitle = `Lecture available: ${lectureDoc.title || 'Lecture'}`;
                    const notifBody = `محاضرة "${lectureDoc.title || ''}" أصبحت متاحة الآن.`;
                    try {
                      const created = await Notification.create({
                        title: notifTitle,
                        body: notifBody,
                        lectureId: lectureDoc._id,
                        chapterId: lectureDoc.chapterId,
                        recipients: recIds,
                        userOnly: true,
                      });
                      createdNotifications.push({ id: created._id, recipients: recIds.length, reason: 'lecture_recovery' });
                      console.info('Created recovery notification (single-video path)', created && created._id, 'for', recIds.length, 'recipients');
                      try {
                        sendNotification({ title: notifTitle, body: notifBody, recipients: recIds, userOnly: true });
                        dbg('Invoked sendNotification for lecture', String(lectureDoc._id), 'recipientsCount', recIds.length);
                      } catch (e) {
                        console.warn('sendNotification failed (single-video path)', e && e.message);
                      }
                    } catch (e) {
                      console.warn('failed to create/send recovery notification (single-video path)', e && e.message);
                    }
                  } else {
                    dbg('No recovery notification recipients found (single-video path) for lecture', String(lectureDoc._id));
                  }
                }
              }
            }
          }
          
        }
      } catch (e) {
        console.warn('lecture recovery check error', e && e.message);
      }
    }
  }

  return { id: video._id, status: video.status, probe: res, createdNotifications };
}

// Check all videos in a lecture and return summary
async function checkLectureVideos(lectureId, opts = {}) {
  const videos = await Video.find({ lectureId }).exec();
  // determine previous per-lecture working state before probes
  const prevTotal = (videos || []).length;
  const prevWorkingCount = (videos || []).filter((vv) => vv && vv.status === 'working').length;
  const perVideo = {};
  let total = 0, broken = 0, working = 0, unknown = 0;
  const createdNotifications = [];
  for (const v of videos) {
    total += 1;
    try {
      const r = await checkSingleVideo(v);
      perVideo[String(v._id)] = r.status || 'unknown';
      if (r && Array.isArray(r.createdNotifications)) {
        createdNotifications.push(...r.createdNotifications);
      }
      if (r.status === 'broken') broken += 1;
      else if (r.status === 'working') working += 1;
      else unknown += 1;
    } catch (e) {
      perVideo[String(v._id)] = 'unknown';
      unknown += 1;
    }
  }

  // If lecture moved from not-fully-working to fully-working, notify enrolled users
  try {
    // only notify when there is at least one video and we transitioned to all-working
    const nowFullyWorking = total > 0 && working === total;
    const wasFullyWorking = prevTotal > 0 && prevWorkingCount === prevTotal;
    if (!wasFullyWorking && nowFullyWorking) {
      // fetch lecture -> chapter -> instructor -> material to find enrolled users
      const chapterModel = require('../models/Chapter');
      const instructorModel = require('../models/Instructor');
      const Enrollment = require('../models/Enrollment');
      const User = require('../models/User');

      const lecture = await Lecture.findById(lectureId).lean().catch(() => null);
      if (lecture) {
        const chapter = await chapterModel.findById(lecture.chapterId).lean().catch(() => null);
        let instructor = null;
        let materialId = null;
        if (chapter && chapter.instructorId) {
          instructor = await instructorModel.findById(chapter.instructorId).lean().catch(() => null);
          if (instructor && instructor.materialId) {
            // instructor.materialId may be an ObjectId or populated object
            materialId = (instructor.materialId && (instructor.materialId._id || instructor.materialId)) || null;
          }
        }

        if (materialId) {
          dbg('Recovery notification: lecture', lectureId, 'materialId', String(materialId));
          // find enrolled users for this material
          const enrolls = await Enrollment.find({ materialId: materialId }).lean().catch((err) => { console.warn('Enrollment.find error', err && err.message); return []; });
          const userIds = Array.isArray(enrolls) ? enrolls.map((e) => e.userId).filter(Boolean) : [];
          dbg('Enrollments count', userIds.length);

          // Build recipient list from enrollments; if none found and FALLBACK_ALL_USERS
          // is enabled, fall back to all non-admin users so students get recovery alerts.
          let recIds = [];
          if (userIds.length > 0) {
            // exclude admins from recipients
            const recipients = await User.find({ _id: { $in: userIds }, isAdmin: { $ne: true } }).select('_id').lean().catch((err) => { console.warn('User.find error', err && err.message); return []; });
            recIds = (recipients || []).map((r) => r._id).filter(Boolean);
          }

          if ((recIds.length === 0) && FALLBACK_ALL_USERS) {
            const fallbackUsers = await User.find({ isAdmin: { $ne: true } }).select('_id').lean().catch(() => []);
            if (!Array.isArray(fallbackUsers)) {
              dbg('Fallback fetch returned non-array, skipping fallback (lecture-level)');
            } else if (fallbackUsers.length > FALLBACK_MAX && !FORCE_FALLBACK) {
              dbg('Fallback aborted (lecture-level): candidates', fallbackUsers.length, 'exceeds max', FALLBACK_MAX);
            } else {
              dbg('Recovery notification fallback: no enrolled recipients, fetching all non-admin users (lecture-level)', fallbackUsers.length, 'candidates');
              recIds.push(...(fallbackUsers || []).map((u) => u._id).filter(Boolean));
            }
          }

          dbg('Recipient non-admin count', recIds.length);
          if (recIds.length > 0) {
            const notifTitle = `Lecture available: ${lecture.title || 'Lecture'}`;
            const notifBody = `محاضرة "${lecture.title || ''}" أصبحت متاحة الآن.`;
            try {
              const created = await Notification.create({
                title: notifTitle,
                body: notifBody,
                lectureId: lecture._id,
                chapterId: lecture.chapterId,
                recipients: recIds,
                userOnly: true,
              });
              console.info('Created recovery notification', created && created._id, 'for', recIds.length, 'users');
              createdNotifications.push({ id: created._id, recipients: recIds.length, reason: 'lecture_recovery' });
              // send SSE to connected clients for enrolled users
              try {
                sendNotification({ title: notifTitle, body: notifBody, recipients: recIds, userOnly: true });
              } catch (e) {
                console.warn('sendNotification failed', e && e.message);
              }
            } catch (e) {
              console.warn('failed to create recovery notification', e && e.message);
            }
          } else {
            dbg('No recipients found for material', String(materialId));
          }
        } else {
          dbg('No materialId found for lecture', lectureId);
        }
      }
    }
  } catch (e) {
    console.warn('recovery notification error', e && e.message);
  }

  return { ok: true, total, broken, working, unknown, perVideo, createdNotifications };
}

module.exports = { checkSingleVideo, checkLectureVideos };
// Return list of non-admin enrolled user IDs who would receive a recovery notification for a lecture
async function getRecoveryRecipientsForLecture(lectureId) {
  try {
    const chapterModel = require('../models/Chapter');
    const instructorModel = require('../models/Instructor');
    const Enrollment = require('../models/Enrollment');
    const User = require('../models/User');

    const debug = { lectureId, lecture: null, chapterId: null, instructorId: null, materialId: null, enrollmentsCount: 0, userIdsCount: 0, recipientsCount: 0, recipients: [] };

    const lecture = await Lecture.findById(lectureId).lean().catch(() => null);
    if (!lecture) return { error: 'lecture not found', debug };
    debug.lecture = { _id: lecture._id, title: lecture.title, chapterId: lecture.chapterId };

    const chapter = await chapterModel.findById(lecture.chapterId).lean().catch(() => null);
    if (!chapter) return { error: 'chapter not found', debug };
    debug.chapterId = chapter._id;
    debug.instructorId = chapter.instructorId || null;

    if (!chapter.instructorId) return { error: 'chapter has no instructorId', debug };

    const instructor = await instructorModel.findById(chapter.instructorId).lean().catch(() => null);
    if (!instructor) return { error: 'instructor not found', debug };
    debug.instructor = { _id: instructor._id, materialId: instructor.materialId };

    const materialId = instructor && instructor.materialId ? (instructor.materialId._id || instructor.materialId) : null;
    if (!materialId) return { error: 'materialId not found on instructor', debug };
    debug.materialId = String(materialId);

    const enrolls = await Enrollment.find({ materialId: materialId }).lean().catch((err) => { debug.enrollError = err && err.message; return []; });
    debug.enrollmentsCount = Array.isArray(enrolls) ? enrolls.length : 0;
    const userIds = Array.isArray(enrolls) ? enrolls.map((e) => e.userId).filter(Boolean) : [];
    debug.userIdsCount = userIds.length;
    debug.sampleUserIds = userIds.slice(0, 10).map(String);

    if (userIds.length === 0) return { recipients: [], debug };

    const recipients = await User.find({ _id: { $in: userIds }, isAdmin: { $ne: true } }).select('_id code email name').lean().catch((err) => { debug.userFindError = err && err.message; return []; });
    debug.recipientsCount = Array.isArray(recipients) ? recipients.length : 0;
    debug.recipients = recipients || [];
    return { recipients, debug };
  } catch (e) {
    return { error: e && e.message };
  }
}

module.exports.getRecoveryRecipientsForLecture = getRecoveryRecipientsForLecture;
