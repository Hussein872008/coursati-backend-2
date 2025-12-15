const Instructor = require('../models/Instructor');
const { uploadImage, deleteFile } = require('../utils/cloudinaryUploader');
const fs = require('fs');

// Create instructor (admin only)
exports.createInstructor = async (req, res) => {
  try {
    const { title, materialId, order } = req.body;
    const file = req.file;

    if (!title || !materialId) {
      if (file && fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }
      return res.status(400).json({ message: 'Title and materialId required' });
    }

    let finalThumbnailUrl = null;
    let uploadedPublicId = null;

    // If file is uploaded, upload to Cloudinary
    if (file) {
      try {
        const uploadResult = await uploadImage(
          file.path,
          'coursati/instructors',
          `instructor_${Date.now()}`
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

    const instructor = await Instructor.create({
      title,
      materialId,
      thumbnailUrl: finalThumbnailUrl,
      thumbnailPublicId: uploadedPublicId || null,
      order: parsedOrder,
    });

    return res.status(201).json(instructor);
  } catch (error) {
    // حذف ملف مؤقت إذا كان موجوداً
    try {
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
    } catch (e) {
      // suppressed temp file removal error
    }
    // حذف الملف من Cloudinary إن تم تحميله
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

// Get instructors by material with chapters count
exports.getInstructorsByMaterial = async (req, res) => {
  try {
    const Chapter = require('../models/Chapter');
    
    const instructors = await Instructor.find({
      materialId: req.params.materialId,
    }).sort({ order: 1 });
    
    // إضافة عدد الفصول لكل مدرس
    const instructorsWithStats = await Promise.all(
      instructors.map(async (instructor) => {
        const chaptersCount = await Chapter.countDocuments({
          instructorId: instructor._id
        });
        
        return {
          ...instructor.toObject(),
          chaptersCount
        };
      })
    );
    
    return res.json(instructorsWithStats);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Get instructor by ID
exports.getInstructorById = async (req, res) => {
  try {
    const instructor = await Instructor.findById(req.params.id).populate('materialId');
    if (!instructor) {
      return res.status(404).json({ message: 'Instructor not found' });
    }
    return res.json(instructor);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Update instructor (admin only)
exports.updateInstructor = async (req, res) => {
  try {
    const { title, order } = req.body;
    const file = req.file;
    const instructor = await Instructor.findById(req.params.id);

    if (!instructor) {
      if (file && fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }
      return res.status(404).json({ message: 'Instructor not found' });
    }

    let finalThumbnailUrl = instructor.thumbnailUrl;
    let finalThumbnailPublicId = instructor.thumbnailPublicId;

    // If new file is uploaded, upload to Cloudinary
    if (file) {
      try {
        const uploadResult = await uploadImage(
          file.path,
          'coursati/instructors',
          `instructor_${req.params.id}`
        );

        if (uploadResult.success) {
          // Delete previous cloud image if exists
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
      return Number.isNaN(n) ? instructor.order || 0 : n;
    })();

    const updatedInstructor = await Instructor.findByIdAndUpdate(
      req.params.id,
      { title, thumbnailUrl: finalThumbnailUrl, thumbnailPublicId: finalThumbnailPublicId, order: parsedOrder },
      { new: true }
    );

    return res.json(updatedInstructor);
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

// Delete instructor (admin only)
exports.deleteInstructor = async (req, res) => {
  try {
    const instructor = await Instructor.findById(req.params.id);
    if (!instructor) {
      return res.status(404).json({ message: 'Instructor not found' });
    }

    // remove cloud image if present
    let publicIdToDelete = instructor.thumbnailPublicId;
    if (!publicIdToDelete && instructor.thumbnailUrl) {
      const { getPublicIdFromUrl } = require('../utils/cloudinaryUploader');
      publicIdToDelete = getPublicIdFromUrl(instructor.thumbnailUrl);
    }
    if (publicIdToDelete) {
      try {
        await deleteFile(publicIdToDelete);
        } catch (e) {
          // suppressed delete warning
        }
    }

    await Instructor.findByIdAndDelete(req.params.id);
    return res.json({ message: 'Instructor deleted' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
