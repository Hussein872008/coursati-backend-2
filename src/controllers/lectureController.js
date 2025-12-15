const Lecture = require('../models/Lecture');
const Notification = require('../models/Notification');
const { uploadImage, deleteFile } = require('../utils/cloudinaryUploader');
const fs = require('fs');

// Create lecture (admin only)
exports.createLecture = async (req, res) => {
  try {
    const { title, chapterId, order } = req.body;
    const file = req.file;

    if (!title || !chapterId) {
      if (file && fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }
      return res.status(400).json({ message: 'Title and chapterId required' });
    }

    let finalThumbnailUrl = null;
    let uploadedPublicId = null;

    // If file is uploaded, upload to Cloudinary
    if (file) {
      try {
        const uploadResult = await uploadImage(
          file.path,
          'coursati/lectures',
          `lecture_${Date.now()}`
        );

        if (uploadResult.success) {
          finalThumbnailUrl = uploadResult.url;
          uploadedPublicId = uploadResult.public_id;
        } else {
          throw new Error(uploadResult.error || 'Upload failed');
        }
      } finally {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      }
    }

    const parsedOrder = (() => {
      const n = parseInt(order, 10);
      return Number.isNaN(n) ? 0 : n;
    })();

    const lecture = await Lecture.create({
      title,
      chapterId,
      thumbnailUrl: finalThumbnailUrl,
      order: parsedOrder,
    });

    // Create a broadcast notification for all users about the new lecture
    try {
      // fetch related names to include in notification
      const Chapter = require('../models/Chapter');
      const Instructor = require('../models/Instructor');
      const Material = require('../models/Material');

      const chapter = await Chapter.findById(lecture.chapterId).lean();
      let instructor = null;
      let material = null;
      if (chapter && chapter.instructorId) {
        instructor = await Instructor.findById(chapter.instructorId).lean();
        if (instructor && instructor.materialId) {
          material = await Material.findById(instructor.materialId).lean();
        }
      }

      const chapterTitle = chapter?.title || null;
      const instructorTitle = instructor?.title || null;
      const materialTitle = material?.title || null;

      // title shown on notification (keeps original short title)
      const notifTitle = `New lecture: ${lecture.title}`;

      await Notification.create({
        title: notifTitle,
        lectureId: lecture._id,
        chapterId: lecture.chapterId,
        instructorId: instructor?._id || null,
        materialId: material?._id || null,
        chapterTitle,
        instructorTitle,
        materialTitle,
        thumbnailUrl: lecture.thumbnailUrl || null,
        recipients: [], // empty = broadcast to all users
      });
    } catch (e) {
      console.error('Failed to create notification for lecture:', e);
    }

    return res.status(201).json(lecture);
  } catch (error) {
    try {
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
    } catch (e) {
      // suppressed temp file removal error
    }
    try {
      if (uploadedPublicId) {
        await deleteFile(uploadedPublicId);
      }
    } catch (e) {
      // suppressed cloud delete error
    }
    return res.status(500).json({ message: error.message });
  }
};

// Get lectures by chapter
exports.getLecturesByChapter = async (req, res) => {
  try {
    const lectures = await Lecture.find({
      chapterId: req.params.chapterId,
    }).sort({ order: 1 });
    return res.json(lectures);
  } catch (error) {
    try {
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
    } catch (e) {
      // suppressed temp file removal error
    }
    try {
      if (uploadedPublicId) {
        await deleteFile(uploadedPublicId);
      }
    } catch (e) {
      // suppressed cloud delete error
    }
    return res.status(500).json({ message: error.message });
  }
};

// Get lecture by ID
exports.getLectureById = async (req, res) => {
  try {
    const lecture = await Lecture.findById(req.params.id)
      .populate('chapterId');
    if (!lecture) {
      return res.status(404).json({ message: 'Lecture not found' });
    }
    return res.json(lecture);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Update lecture (admin only)
exports.updateLecture = async (req, res) => {
  try {
    const { title, order } = req.body;
    const file = req.file;
    const lecture = await Lecture.findById(req.params.id);

    if (!lecture) {
      if (file && fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }
      return res.status(404).json({ message: 'Lecture not found' });
    }

    let finalThumbnailUrl = lecture.thumbnailUrl;

    // If new file is uploaded, upload to Cloudinary
    if (file) {
      try {
        const uploadResult = await uploadImage(
          file.path,
          'coursati/lectures',
          `lecture_${req.params.id}`
        );

        if (uploadResult.success) {
          finalThumbnailUrl = uploadResult.url;
        } else {
          throw new Error(uploadResult.error || 'Upload failed');
        }
      } finally {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      }
    }

    const parsedOrder = (() => {
      const n = parseInt(order, 10);
      return Number.isNaN(n) ? lecture.order || 0 : n;
    })();

    const updatedLecture = await Lecture.findByIdAndUpdate(
      req.params.id,
      { title, thumbnailUrl: finalThumbnailUrl, order: parsedOrder },
      { new: true }
    );

    return res.json(updatedLecture);
  } catch (error) {
    try {
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
    } catch (e) {
      // suppressed temp file removal error
    }
    return res.status(500).json({ message: error.message });
  }
};

// Delete lecture (admin only)
exports.deleteLecture = async (req, res) => {
  try {
    const lecture = await Lecture.findByIdAndDelete(req.params.id);
    if (!lecture) {
      return res.status(404).json({ message: 'Lecture not found' });
    }
    return res.json({ message: 'Lecture deleted' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Get viewers for a Lecture (admin only)
exports.getLectureViewers = async (req, res) => {
  try {
    const lectureId = req.params.id;
    const LectureView = require('../models/LectureView');
    const viewers = await LectureView.find({ lectureId }).populate('userId', 'name code');
    const result = viewers.map((v) => ({
      userId: v.userId?._id || null,
      name: v.userId?.name || null,
      code: v.userId?.code || null,
      viewedAt: v.createdAt,
    }));
    return res.json(result);
  } catch (err) {
    console.error('getLectureViewers error:', err);
    return res.status(500).json({ message: err.message });
  }
};

// Record a lecture view by the authenticated user
exports.recordLectureView = async (req, res) => {
  try {
    const lectureId = req.params.id;
    const user = req.user; // set by authMiddleware
    if (!user || !user._id) return res.status(401).json({ message: 'Unauthorized' });

    const LectureView = require('../models/LectureView');
    const Lecture = require('../models/Lecture');

    try {
      // create view record; unique index prevents duplicates
      await LectureView.create({ userId: user._id, lectureId });
      // increment viewCount on lecture (non-blocking)
      try { await Lecture.findByIdAndUpdate(lectureId, { $inc: { viewCount: 1 } }); } catch (e) { }
    } catch (e) {
      // ignore duplicate key errors (user already viewed)
      if (e.code && e.code !== 11000) console.error('recordLectureView create error', e);
    }

    return res.json({ message: 'View recorded' });
  } catch (err) {
    console.error('recordLectureView error:', err);
    return res.status(500).json({ message: err.message });
  }
};
