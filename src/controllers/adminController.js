const Material = require('../models/Material');
const Instructor = require('../models/Instructor');
const Chapter = require('../models/Chapter');
const Lecture = require('../models/Lecture');
const PDF = require('../models/PDF');
const User = require('../models/User');
const Enrollment = require('../models/Enrollment');
const PDFView = require('../models/PDFView');
const LectureView = require('../models/LectureView');
const Video = require('../models/Video');
const VideoView = require('../models/VideoView');

// GET /api/admin/stats
exports.getStats = async (req, res) => {
  try {
    const [materialsCount, instructorsCount, chaptersCount, lecturesCount, videosCount, pdfsCount, usersCount, enrollmentsCount] = await Promise.all([
      Material.countDocuments(),
      Instructor.countDocuments(),
      Chapter.countDocuments(),
      Lecture.countDocuments(),
      Video.countDocuments(),
      PDF.countDocuments(),
      // exclude admin accounts from the public user count
      User.countDocuments({ isAdmin: { $ne: true } }),
      Enrollment.countDocuments(),
    ]);

    // basic view counts from aggregated view documents (fallback to sum of viewCount fields)
    const [pdfViews, lectureViews, videoViews] = await Promise.all([
      PDFView.countDocuments(),
      LectureView.countDocuments(),
      VideoView.countDocuments(),
    ]).catch(() => [0, 0, 0]);

    return res.json({
      totals: {
        materials: materialsCount,
        instructors: instructorsCount,
        chapters: chaptersCount,
        lectures: lecturesCount,
        videos: videosCount,
        pdfs: pdfsCount,
        users: usersCount,
        enrollments: enrollmentsCount,
      },
      viewCounts: {
        pdfViews,
        lectureViews,
        videoViews,
      }
    });
  } catch (err) {
    console.error('getStats error', err);
    return res.status(500).json({ message: err.message });
  }
};

// GET /api/admin/activity?limit=20
exports.getActivity = async (req, res) => {
  try {
    const limit = Math.min(50, parseInt(req.query.limit || '20', 10));

    // recent items across several collections (videos removed - video functionality has been removed from the project)
    const [recentPdfs, recentVideos, recentUsers] = await Promise.all([
      PDF.find().sort({ createdAt: -1 }).limit(limit).select('title lectureId createdAt'),
      Video.find().sort({ createdAt: -1 }).limit(limit).select('title lectureId createdAt'),
      User.find().sort({ createdAt: -1 }).limit(limit).select('name code createdAt'),
    ]);

    // Normalize into activity feed items
    const feed = [];
    recentPdfs.forEach(p => feed.push({ type: 'pdf', title: p.title, refId: p._id, lectureId: p.lectureId, createdAt: p.createdAt }));
    recentVideos.forEach(v => feed.push({ type: 'video', title: v.title, refId: v._id, lectureId: v.lectureId, createdAt: v.createdAt }));
    recentUsers.forEach(u => feed.push({ type: 'user', name: u.name, code: u.code, refId: u._id, createdAt: u.createdAt }));

    // sort unified feed by createdAt desc and return top `limit`
    feed.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.json(feed.slice(0, limit));
  } catch (err) {
    console.error('getActivity error', err);
    return res.status(500).json({ message: err.message });
  }
};

// GET /api/admin/stats/timeseries?days=30
exports.getTimeSeries = async (req, res) => {
  try {
    const days = Math.min(180, parseInt(req.query.days || '30', 10));
    const end = new Date();
    end.setHours(0,0,0,0);
    const start = new Date(end.getTime() - (days - 1) * 24 * 60 * 60 * 1000);

    // Helper to aggregate counts per day for a model
    const aggregateByDay = async (Model, dateField = 'createdAt') => {
      const pipeline = [
        { $match: { [dateField]: { $gte: start, $lte: end } } },
        { $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: `$${dateField}` } },
            count: { $sum: 1 }
        } },
        { $sort: { _id: 1 } }
      ];
      const rows = await Model.aggregate(pipeline);
      // convert to map date->count
      const map = {};
      rows.forEach(r => { map[r._id] = r.count; });
      // produce array aligned to dates
      const out = [];
      for (let i = 0; i < days; i++) {
        const d = new Date(start.getTime() + i * 24 * 60 * 60 * 1000);
        const key = d.toISOString().slice(0,10);
        out.push({ date: key, count: map[key] || 0 });
      }
      return out;
    };

    // Include material creation series and view series (PDF/Lecture/Video)
    const [materialSeries, pdfSeries, lectureSeries, videoSeries] = await Promise.all([
      aggregateByDay(require('../models/Material')),
      aggregateByDay(require('../models/PDFView')),
      aggregateByDay(require('../models/LectureView')),
      aggregateByDay(require('../models/VideoView')),
    ]);

    return res.json({ days, start: start.toISOString().slice(0,10), end: end.toISOString().slice(0,10), materialSeries, pdfSeries, lectureSeries, videoSeries });
  } catch (err) {
    console.error('getTimeSeries error', err);
    return res.status(500).json({ message: err.message });
  }
};

module.exports = exports;

// GET /api/admin/videos/status-summary
exports.getVideoStatusSummary = async (req, res) => {
  try {
    // Global counts from videos collection
    const total = await Video.countDocuments();
    const working = await Video.countDocuments({ status: 'working' });
    const broken = await Video.countDocuments({ status: 'broken' });
    const health = total > 0 ? Math.round(((working / total) * 100) * 100) / 100 : 100;

    // Produce a per-lecture list that includes all lectures (even if they have zero videos)
    const pipeline = [
      { $lookup: { from: 'videos', localField: '_id', foreignField: 'lectureId', as: 'videos' } },
      { $project: {
          lectureId: '$_id',
          lectureTitle: '$title',
          total: { $size: '$videos' },
          working: { $size: { $filter: { input: '$videos', as: 'v', cond: { $eq: ['$$v.status', 'working'] } } } },
          broken: { $size: { $filter: { input: '$videos', as: 'v', cond: { $eq: ['$$v.status', 'broken'] } } } },
          videos: { $map: { input: '$videos', as: 'v', in: { _id: '$$v._id', title: '$$v.title', status: '$$v.status', duration: '$$v.duration' } } }
        }
      },
      { $sort: { lectureTitle: 1 } },
    ];

    const perLecture = await Lecture.aggregate(pipeline).exec();

    return res.json({ total, working, broken, health, perLecture });
  } catch (err) {
    console.error('getVideoStatusSummary error', err);
    return res.status(500).json({ message: err.message });
  }
};

// Note: historical probe metrics and per-video status histories removed to keep DB small.
