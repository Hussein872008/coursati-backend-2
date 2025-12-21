const Material = require('../models/Material');
const Enrollment = require('../models/Enrollment');
const { uploadImage, deleteFile } = require('../utils/cloudinaryUploader');
const fs = require('fs');

// Create material (admin only)
exports.createMaterial = async (req, res) => {
  try {
    // production: debug logs removed

    const { title, order } = req.body;
    const file = req.file;

    if (!title) {
      // حذف الملف إذا كان موجوداً
      if (file && fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }
      return res.status(400).json({ message: 'Title required' });
    }

    let finalThumbnailUrl = null;
    let uploadedPublicId = null;

    // If file is uploaded, upload to Cloudinary
    if (file) {
      try {
        const uploadResult = await uploadImage(
          file.path,
          'coursati/materials',
          `material_${Date.now()}`
        );

        if (uploadResult.success) {
          finalThumbnailUrl = uploadResult.url;
          uploadedPublicId = uploadResult.public_id;
        } else {
          throw new Error(uploadResult.error || 'Upload failed');
        }
      } finally {
        // حذف الملف المؤقت
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      }
    }

    const parsedOrder = (() => {
      const n = parseInt(order, 10);
      return Number.isNaN(n) ? 0 : n;
    })();

    const material = await Material.create({
      title,
      thumbnailUrl: finalThumbnailUrl,
      thumbnailPublicId: uploadedPublicId || null,
      order: parsedOrder,
    });

    return res.status(201).json(material);
  } catch (error) {
    // تنظيف الملفات في حالة الخطأ
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    // حذف الملف من Cloudinary إن تم تحميله لكنه لم يُسجل في الداتا-بيز
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

// Get all materials with instructor count
exports.getAllMaterials = async (req, res) => {
  try {
    const Instructor = require('../models/Instructor');
    
    const materials = await Material.find().sort({ order: 1 });
    
    // إضافة عدد المدرسين لكل مادة
    const materialsWithStats = await Promise.all(
      materials.map(async (material) => {
        // احصل على عدد المدرسين المرتبطين بهذه المادة
        const instructorsCount = await Instructor.countDocuments({
          materialId: material._id
        });
        
        return {
          ...material.toObject(),
          instructorsCount
        };
      })
    );
    
    return res.json(materialsWithStats);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Get material by ID with instructor count
exports.getMaterialById = async (req, res) => {
  try {
    const Instructor = require('../models/Instructor');
    
    const material = await Material.findById(req.params.id);
    if (!material) {
      return res.status(404).json({ message: 'Material not found' });
    }
    
    // احصل على عدد المدرسين المرتبطين بهذه المادة
    const instructorsCount = await Instructor.countDocuments({
      materialId: material._id
    });
    
    const materialWithStats = {
      ...material.toObject(),
      instructorsCount
    };
    
    return res.json(materialWithStats);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Update material (admin only)
exports.updateMaterial = async (req, res) => {
  try {
    const { title, thumbnailUrl, order } = req.body;
    const material = await Material.findById(req.params.id);

    if (!material) {
      return res.status(404).json({ message: 'Material not found' });
    }

    let finalThumbnailUrl = material.thumbnailUrl;
    let finalThumbnailPublicId = material.thumbnailPublicId;
    const file = req.file;

    // DEBUG: log incoming update info to help diagnose upload/delete issues
    try {
      console.log(`updateMaterial: id=${req.params.id} hasFile=${!!req.file} thumbnailUrlType=${typeof thumbnailUrl}`);
    } catch (e) {}

    // Case A: new file uploaded via multipart/form-data (multer -> req.file)
    if (file) {
      try {
        const uploadResult = await uploadImage(
          file.path,
          'coursati/materials',
          `material_${req.params.id}`
        );

        // remove temp file
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);

        if (uploadResult.success) {
          // delete previous cloud asset if present
          if (material.thumbnailPublicId) {
            try {
              console.log(`updateMaterial: deleting previous publicId=${material.thumbnailPublicId}`);
              await deleteFile(material.thumbnailPublicId);
            } catch (e) {
              console.error('updateMaterial: failed deleting previous publicId', e?.message || e);
            }
          }

          finalThumbnailUrl = uploadResult.url;
          finalThumbnailPublicId = uploadResult.public_id;
        } else {
          return res.status(400).json({
            message: 'Failed to upload thumbnail',
            error: uploadResult.error,
          });
        }
      } catch (e) {
        // cleanup temp file on unexpected error
        if (file && file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
        throw e;
      }
    } else if (typeof thumbnailUrl !== 'undefined' && (thumbnailUrl === null || thumbnailUrl === '')) {
      // Case B: explicit removal of thumbnail (thumbnailUrl null/empty sent)
      if (material.thumbnailPublicId) {
        try {
          console.log(`updateMaterial: explicit removal deleting publicId=${material.thumbnailPublicId}`);
          await deleteFile(material.thumbnailPublicId);
        } catch (e) {
          console.error('updateMaterial: failed deleting previous publicId on removal', e?.message || e);
        }
      } else if (material.thumbnailUrl) {
        const { getPublicIdFromUrl } = require('../utils/cloudinaryUploader');
        const publicId = getPublicIdFromUrl(material.thumbnailUrl);
        if (publicId) {
          try { console.log(`updateMaterial: explicit removal deleting extracted publicId=${publicId}`); await deleteFile(publicId); } catch (e) { console.error('updateMaterial: failed deleting extracted publicId', e?.message || e); }
        }
      }

      finalThumbnailUrl = null;
      finalThumbnailPublicId = null;
    } else if (thumbnailUrl && thumbnailUrl !== material.thumbnailUrl) {
      // Case C: thumbnail replaced by a URL string -> upload from URL
      const uploadResult = await uploadImage(
        thumbnailUrl,
        'coursati/materials',
        `material_${req.params.id}`
      );

      if (uploadResult.success) {
        // delete previous cloud asset if present
        if (material.thumbnailPublicId) {
          try { await deleteFile(material.thumbnailPublicId); } catch (e) { console.error('updateMaterial: failed deleting previous after URL upload', e?.message || e); }
        }

        finalThumbnailUrl = uploadResult.url;
        finalThumbnailPublicId = uploadResult.public_id;
      } else {
        console.error('updateMaterial: upload from URL failed', uploadResult.error);
        return res.status(400).json({
          message: 'Failed to upload thumbnail',
          error: uploadResult.error,
        });
      }
    }

    const parsedOrderUpdate = (() => {
      const n = parseInt(order, 10);
      return Number.isNaN(n) ? material.order || 0 : n;
    })();

    const updatedMaterial = await Material.findByIdAndUpdate(
      req.params.id,
      { title, thumbnailUrl: finalThumbnailUrl, thumbnailPublicId: finalThumbnailPublicId || material.thumbnailPublicId, order: parsedOrderUpdate },
      { new: true }
    );

    return res.json(updatedMaterial);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Delete material (admin only)
exports.deleteMaterial = async (req, res) => {
  try {
    const material = await Material.findById(req.params.id);
    if (!material) {
      return res.status(404).json({ message: 'Material not found' });
    }

    // remove cloud image if present
    let publicIdToDelete = material.thumbnailPublicId;
    if (!publicIdToDelete && material.thumbnailUrl) {
      // try to extract from URL
      const { getPublicIdFromUrl } = require('../utils/cloudinaryUploader');
      publicIdToDelete = getPublicIdFromUrl(material.thumbnailUrl);
    }
    if (publicIdToDelete) {
      try {
        await deleteFile(publicIdToDelete);
      } catch (e) {
        // suppressed delete warning
      }
    }

    await Material.findByIdAndDelete(req.params.id);
    return res.json({ message: 'Material deleted' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Enroll currently authenticated user to a material
exports.enrollToMaterial = async (req, res) => {
  try {
    const materialId = req.params.id;
    const user = req.user;
    if (!user) return res.status(401).json({ message: 'Auth required' });

    // ensure material exists
    const material = await Material.findById(materialId);
    if (!material) return res.status(404).json({ message: 'Material not found' });

    // create enrollment, ignore duplicate errors
    try {
      const enrollment = await Enrollment.create({ userId: user._id, materialId });
      return res.status(201).json(enrollment);
    } catch (err) {
      // Duplicate key -> already enrolled
      if (err.code === 11000) {
        return res.status(200).json({ message: 'Already enrolled' });
      }
      throw err;
    }
  } catch (error) {
    console.error('enrollToMaterial error:', error);
    return res.status(500).json({ message: error.message });
  }
};

// Return number of unique students enrolled for a material
exports.getStudentsCount = async (req, res) => {
  try {
    const materialId = req.params.id;
    const material = await Material.findById(materialId);
    if (!material) return res.status(404).json({ message: 'Material not found' });

    const count = await Enrollment.countDocuments({ materialId });
    return res.json({ count });
  } catch (error) {
    console.error('getStudentsCount error:', error);
    return res.status(500).json({ message: error.message });
  }
};
