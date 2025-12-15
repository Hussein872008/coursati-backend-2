const Chapter = require('../models/Chapter');
const { uploadImage, deleteFile } = require('../utils/cloudinaryUploader');
const fs = require('fs');

// Create chapter (admin only)
exports.createChapter = async (req, res) => {
  try {
    const { title, instructorId, order } = req.body;
    const file = req.file;

    if (!title || !instructorId) {
      if (file && fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }
      return res.status(400).json({ message: 'Title and instructorId required' });
    }

    let finalThumbnailUrl = null;
    let uploadedPublicId = null;

    // If file is uploaded, upload to Cloudinary
    if (file) {
      try {
        const uploadResult = await uploadImage(
          file.path,
          'coursati/chapters',
          `chapter_${Date.now()}`
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

    const chapter = await Chapter.create({
      title,
      instructorId,
      thumbnailUrl: finalThumbnailUrl,
      thumbnailPublicId: uploadedPublicId || null,
      order: (() => {
        const n = parseInt(order, 10);
        return Number.isNaN(n) ? 0 : n;
      })(),
    });

    return res.status(201).json(chapter);
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

// Get chapters by instructor with lectures
exports.getChaptersByInstructor = async (req, res) => {
  try {
    const Chapter = require('../models/Chapter');
    const Lecture = require('../models/Lecture');
    
    const chapters = await Chapter.find({
      instructorId: req.params.instructorId,
    }).sort({ order: 1 });

    // لكل فصل، احصل على المحاضرات المرتبطة به
    const chaptersWithLectures = await Promise.all(
      chapters.map(async (chapter) => {
        const lectures = await Lecture.find({
          chapterId: chapter._id,
        }).sort({ order: 1 });
        return {
          ...chapter.toObject(),
          lectures,
        };
      })
    );

    return res.json(chaptersWithLectures);
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

// Get chapter by ID
exports.getChapterById = async (req, res) => {
  try {
    const chapter = await Chapter.findById(req.params.id)
      .populate('instructorId')
      .lean();
    
    if (!chapter) {
      return res.status(404).json({ message: 'Chapter not found' });
    }

    // جلب جميع المحاضرات للفصل مع الملفات (videos removed - video functionality has been removed from the project)
    const Lecture = require('../models/Lecture');
    const PDF = require('../models/PDF');
    
    const lectures = await Lecture.find({ chapterId: req.params.id }).lean();
    
    // جلب الملفات لكل محاضرة
    const lecturesWithContent = await Promise.all(
      lectures.map(async (lecture) => {
        const pdfs = await PDF.find({ lectureId: lecture._id }).lean();
        // ALSO fetch videos for this lecture so frontend can show videos+pdfs together
        let videos = [];
        try {
          const Video = require('../models/Video');
          videos = await Video.find({ lectureId: lecture._id }).lean();
        } catch (e) {
          videos = [];
        }
        return {
          ...lecture,
          pdfs: pdfs || [],
          videos: videos || []
        };
      })
    );

    // compute chapter total view count from lectures' viewCount
    const chapterViewCount = (lecturesWithContent || []).reduce((sum, l) => sum + (l.viewCount || 0), 0);

    return res.json({
      ...chapter,
      viewCount: chapterViewCount,
      lectures: lecturesWithContent || []
    });
  } catch (error) {
    console.error('Error in getChapterById:', error);
    return res.status(500).json({ message: error.message });
  }
};

// Update chapter (admin only)
exports.updateChapter = async (req, res) => {
  try {
    const { title, order } = req.body;
    const file = req.file;
    const chapter = await Chapter.findById(req.params.id);

    if (!chapter) {
      if (file && fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }
      return res.status(404).json({ message: 'Chapter not found' });
    }

    let finalThumbnailUrl = chapter.thumbnailUrl;
    let finalThumbnailPublicId = chapter.thumbnailPublicId;

    // If new file is uploaded, upload to Cloudinary
    if (file) {
      try {
        const uploadResult = await uploadImage(
          file.path,
          'coursati/chapters',
          `chapter_${req.params.id}`
        );

        if (uploadResult.success) {
          // delete previous cloud image if exists
          if (finalThumbnailPublicId) {
            try { await deleteFile(finalThumbnailPublicId); } catch (e) { /* suppressed delete warning */ }
          }

          finalThumbnailUrl = uploadResult.url;
          finalThumbnailPublicId = uploadResult.public_id;
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
      return Number.isNaN(n) ? chapter.order || 0 : n;
    })();

    const updatedChapter = await Chapter.findByIdAndUpdate(
      req.params.id,
      { title, thumbnailUrl: finalThumbnailUrl, thumbnailPublicId: finalThumbnailPublicId, order: parsedOrder },
      { new: true }
    );

    return res.json(updatedChapter);
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

// Delete chapter (admin only)
exports.deleteChapter = async (req, res) => {
  try {
    const chapter = await Chapter.findById(req.params.id);
    if (!chapter) {
      return res.status(404).json({ message: 'Chapter not found' });
    }

    // remove cloud image if present
    let publicIdToDelete = chapter.thumbnailPublicId;
    if (!publicIdToDelete && chapter.thumbnailUrl) {
      const { getPublicIdFromUrl } = require('../utils/cloudinaryUploader');
      publicIdToDelete = getPublicIdFromUrl(chapter.thumbnailUrl);
    }
    if (publicIdToDelete) {
      try {
        await deleteFile(publicIdToDelete);
      } catch (e) {
        // suppressed delete warning
      }
    }

    await Chapter.findByIdAndDelete(req.params.id);
    return res.json({ message: 'Chapter deleted' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
