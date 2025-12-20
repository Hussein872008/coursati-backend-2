const Chapter = require('../models/Chapter');
const Lecture = require('../models/Lecture');
const Material = require('../models/Material');
const PDF = require('../models/PDF');
const Video = require('../models/Video');
const Instructor = require('../models/Instructor');

// Global search: return richer metadata to show thumbnails, parent titles, and timestamps
exports.globalSearch = async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(200).json({ results: {} });

  const regex = new RegExp(q.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&'), 'i');

  const [chapters, lectures, materials, pdfs, videos, instructors] = await Promise.all([
    Chapter.find({ title: regex })
      .limit(10)
      .populate({ path: 'instructorId', select: 'title thumbnailUrl materialId', populate: { path: 'materialId', select: 'title thumbnailUrl' } })
      .lean(),

    Lecture.find({ title: regex })
      .limit(12)
      .populate({ path: 'chapterId', select: 'title thumbnailUrl instructorId', populate: { path: 'instructorId', select: 'title thumbnailUrl materialId', populate: { path: 'materialId', select: 'title thumbnailUrl' } } })
      .lean(),

    Material.find({ title: regex }).limit(8).lean(),

    PDF.find({ title: regex })
      .limit(8)
      .populate({ path: 'lectureId', select: 'title thumbnailUrl chapterId', populate: { path: 'chapterId', select: 'title thumbnailUrl' } })
      .lean(),

    Video.find({ title: regex })
      .limit(8)
      .populate({ path: 'lectureId', select: 'title thumbnailUrl chapterId', populate: { path: 'chapterId', select: 'title thumbnailUrl instructorId', populate: { path: 'instructorId', select: 'title thumbnailUrl materialId', populate: { path: 'materialId', select: 'title thumbnailUrl' } } } })
      .lean(),

    Instructor.find({ title: regex }).limit(8).populate({ path: 'materialId', select: 'title thumbnailUrl' }).lean(),
  ]);

  const norm = {
    chapters: chapters.map((c) => {
      const instructor = c.instructorId || null;
      const material = instructor && instructor.materialId ? instructor.materialId : null;
      const thumbnail = c.thumbnailUrl || c.thumbnail || (instructor && instructor.thumbnailUrl) || (material && material.thumbnailUrl) || null;
      const subtitleParts = [instructor ? instructor.title : null, material ? material.title : null].filter(Boolean);
      return {
        _id: c._id,
        title: c.title,
        type: 'chapter',
        instructorId: instructor ? instructor._id : null,
        instructorTitle: instructor ? instructor.title : null,
        materialId: material ? material._id : null,
        materialTitle: material ? material.title : null,
        thumbnailUrl: thumbnail,
        subtitle: subtitleParts.join(' — '),
        createdAt: c.createdAt,
      };
    }),

    lectures: lectures.map((l) => {
      const chap = l.chapterId || null;
      const instr = chap && chap.instructorId ? chap.instructorId : null;
      const material = instr && instr.materialId ? instr.materialId : null;
      const thumbnail = l.thumbnailUrl || l.thumbnail || (chap && chap.thumbnailUrl) || (instr && instr.thumbnailUrl) || (material && material.thumbnailUrl) || null;
      const subtitleParts = [chap ? chap.title : null, instr ? instr.title : null, material ? material.title : null].filter(Boolean);
      return {
        _id: l._id,
        title: l.title,
        type: 'lecture',
        chapterId: chap ? chap._id : null,
        chapterTitle: chap ? chap.title : null,
        instructorTitle: instr ? instr.title : null,
        materialTitle: material ? material.title : null,
        thumbnailUrl: thumbnail,
        subtitle: subtitleParts.join(' — '),
        createdAt: l.createdAt,
      };
    }),

    materials: materials.map((m) => ({
      _id: m._id,
      title: m.title,
      type: 'material',
      thumbnailUrl: m.thumbnailUrl || m.thumbnail || null,
      subtitle: '',
      createdAt: m.createdAt,
    })),

    pdfs: pdfs.map((p) => {
      const lec = p.lectureId || null;
      const chap = lec && lec.chapterId ? lec.chapterId : null;
      const thumbnail = (lec && lec.thumbnailUrl) || (chap && chap.thumbnailUrl) || null;
      const subtitleParts = [lec ? lec.title : null, chap ? chap.title : null].filter(Boolean);
      return {
        _id: p._id,
        title: p.title,
        type: 'pdf',
        lectureId: lec ? lec._id : null,
        chapterId: chap ? chap._id : null,
        lectureTitle: lec ? lec.title : null,
        chapterTitle: chap ? chap.title : null,
        thumbnailUrl: thumbnail,
        subtitle: subtitleParts.join(' — '),
        createdAt: p.createdAt,
      };
    }),

    videos: videos.map((v) => {
      const lec = v.lectureId || null;
      const chap = lec && lec.chapterId ? lec.chapterId : null;
      const instr = chap && chap.instructorId ? chap.instructorId : null;
      const material = instr && instr.materialId ? instr.materialId : null;
      const thumbnail = (v.thumbnailUrl || v.thumbnail) || (lec && lec.thumbnailUrl) || (chap && chap.thumbnailUrl) || (instr && instr.thumbnailUrl) || (material && material.thumbnailUrl) || null;
      const subtitleParts = [lec ? lec.title : null, chap ? chap.title : null, instr ? instr.title : null, material ? material.title : null].filter(Boolean);
      return {
        _id: v._id,
        title: v.title,
        type: 'video',
        lectureId: lec ? lec._id : null,
        chapterId: chap ? chap._id : null,
        lectureTitle: lec ? lec.title : null,
        chapterTitle: chap ? chap.title : null,
        instructorTitle: instr ? instr.title : null,
        materialTitle: material ? material.title : null,
        thumbnailUrl: thumbnail,
        subtitle: subtitleParts.join(' — '),
        createdAt: v.createdAt,
      };
    }),
    instructors: instructors.map((ins) => ({
      _id: ins._id,
      title: ins.title,
      type: 'instructor',
      thumbnailUrl: ins.thumbnailUrl || ins.thumbnail || null,
      materialTitle: ins.materialId ? ins.materialId.title : null,
      subtitle: ins.materialId ? ins.materialId.title : '',
      createdAt: ins.createdAt,
    })),
  };

  return res.json({ results: norm });
};
