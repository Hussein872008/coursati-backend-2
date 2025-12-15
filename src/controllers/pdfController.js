const PDF = require('../models/PDF');
const Lecture = require('../models/Lecture');
const { uploadPdf: uploadPdfToSupabase } = require('../utils/supabasePdf');
const { deleteFile } = require('../utils/cloudinaryUploader');
const fs = require('fs');
const path = require('path');
const PDFView = require('../models/PDFView');

// Normalize fileUrl which might be sent as a string or as an object from client widgets
const resolveFileUrl = (input) => {
  if (!input) return null;
  if (typeof input === 'string') return input;
  if (typeof input === 'object') {
    // common possible keys
    return input.url || input.secure_url || input.secureUrl || input.fileUrl || null;
  }
  return null;
};

// Create PDF (admin only)
exports.createPDF = async (req, res) => {
  try {
    const { title, lectureId, order, fileUrl: bodyFileUrl } = req.body;
    const file = req.file;

    if (!title || !lectureId) {
      if (file && fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }
      return res
        .status(400)
        .json({ message: 'Title and lectureId required' });
    }

    // prefer uploaded file, fallback to fileUrl sent in body
    let finalFileUrl = resolveFileUrl(bodyFileUrl) || null;

    // If file is uploaded, upload to Supabase (PDFs only)
    if (file) {
      try {
        if (file.mimetype !== 'application/pdf') {
          throw new Error('Only PDF files are allowed');
        }

        const publicUrl = await uploadPdfToSupabase(file.path, file.originalname);
        if (!publicUrl) throw new Error('Failed to get public URL from Supabase');
        finalFileUrl = publicUrl;
      } finally {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      }
    }

    // ensure we have a file URL before creating the DB record
    if (!finalFileUrl) {
      return res.status(400).json({ message: 'fileUrl is required (either upload a file or provide fileUrl in body)' });
    }

    const pdf = await PDF.create({
      title,
      lectureId,
      fileUrl: finalFileUrl,
      order: order || 0,
    });

    // Also push to Lecture.pdfs array for quick access (if lecture exists)
    try {
      await Lecture.findByIdAndUpdate(lectureId, {
        $push: { pdfs: { url: finalFileUrl, name: title || path.basename(finalFileUrl), uploadedAt: new Date() } }
      });
    } catch (pushErr) {
      // Failed to push PDF into Lecture.pdfs (suppressed)
    }

    return res.status(201).json(pdf);
  } catch (error) {
    console.error('createPDF error:', error);
    return res.status(500).json({ message: error.message, stack: error.stack });
  }
};

// Get PDFs by lecture
exports.getPDFsByLecture = async (req, res) => {
  try {
    const pdfs = await PDF.find({ lectureId: req.params.lectureId }).sort({
      order: 1,
    });
    return res.json(pdfs);
  } catch (error) {
    console.error('getPDFsByLecture error:', error);
    return res.status(500).json({ message: error.message, stack: error.stack });
  }
};

// Get PDF by ID
exports.getPDFById = async (req, res) => {
  try {
    const pdf = await PDF.findById(req.params.id);
    if (!pdf) {
      return res.status(404).json({ message: 'PDF not found' });
    }
    return res.json(pdf);
  } catch (error) {
    console.error('getPDFById error:', error);
    return res.status(500).json({ message: error.message, stack: error.stack });
  }
};

// Record a view for a PDF (unique per user)
exports.viewPDF = async (req, res) => {
  try {
    const pdfId = req.params.id;
    const user = req.user; // may be undefined when optionalAuth used

    // request info logging removed for production

    // If user exists, try to record a unique view per user
    if (user) {
      let created = false;
      try {
        await PDFView.create({ userId: user._id, pdfId });
        created = true;
      } catch (err) {
        if (err && err.code === 11000) {
          created = false;
        } else {
          // PDFView create error (non-duplicate) suppressed
        }
      }

      let updatedPdf = null;
      if (created) {
        updatedPdf = await PDF.findByIdAndUpdate(pdfId, { $inc: { viewCount: 1 } }, { new: true });
      } else {
        updatedPdf = await PDF.findById(pdfId);
      }

      return res.json({ ok: true, viewCount: updatedPdf ? (updatedPdf.viewCount || 0) : 0 });
    }

    // Anonymous view: just increment the counter (no uniqueness guarantee)
    const updatedPdf = await PDF.findByIdAndUpdate(pdfId, { $inc: { viewCount: 1 } }, { new: true });
    return res.json({ ok: true, viewCount: updatedPdf ? (updatedPdf.viewCount || 0) : 0 });
  } catch (error) {
    console.error('viewPDF error:', error);
    return res.status(500).json({ message: error.message });
  }
};

// Get viewers for a PDF (admin only)
exports.getPDFViewers = async (req, res) => {
  try {
    const pdfId = req.params.id;
    const viewers = await PDFView.find({ pdfId }).populate('userId', 'name code');
    const result = viewers.map((v) => ({
      userId: v.userId?._id || null,
      name: v.userId?.name || null,
      code: v.userId?.code || null,
      viewedAt: v.createdAt,
    }));
    return res.json(result);
  } catch (err) {
    console.error('getPDFViewers error:', err);
    return res.status(500).json({ message: err.message });
  }
};

// Update PDF (admin only)
exports.updatePDF = async (req, res) => {
  try {
    const { title, order } = req.body;
    const file = req.file;
    const pdf = await PDF.findById(req.params.id);

    if (!pdf) {
      if (file && fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }
      return res.status(404).json({ message: 'PDF not found' });
    }

    // prefer newly uploaded file, fallback to body.fileUrl (normalized), otherwise keep existing
    let finalFileUrl = resolveFileUrl(req.body.fileUrl) || pdf.fileUrl;

    // If new file is uploaded, upload to Supabase
    if (file) {
      try {
        if (file.mimetype !== 'application/pdf') {
          throw new Error('Only PDF files are allowed');
        }
        const publicUrl = await uploadPdfToSupabase(file.path, file.originalname);
        if (!publicUrl) throw new Error('Failed to get public URL from Supabase');
        finalFileUrl = publicUrl;
      } finally {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      }
    }

    const updatedPDF = await PDF.findByIdAndUpdate(
      req.params.id,
      { title, fileUrl: finalFileUrl, order },
      { new: true }
    );

    return res.json(updatedPDF);
  } catch (error) {
    console.error('updatePDF error:', error);
    return res.status(500).json({ message: error.message, stack: error.stack });
  }
};

// Delete PDF (admin only) — also attempts to delete file from Supabase storage
exports.deletePDF = async (req, res) => {
  try {
    const pdf = await PDF.findById(req.params.id);
    if (!pdf) {
      return res.status(404).json({ message: 'PDF not found' });
    }

    // Try to remove file from Supabase (best-effort)
    let storageResult = { ok: true };
    try {
      const { deletePdfByUrl } = require('../utils/supabasePdf');
      if (pdf.fileUrl) {
        storageResult = await deletePdfByUrl(pdf.fileUrl);
      }
    } catch (err) {
      // Supabase delete helper failed (suppressed)
      storageResult = { ok: false, error: err };
    }

    // Delete DB record regardless of storage outcome (but report status)
    await PDF.findByIdAndDelete(req.params.id);

    const response = { message: 'PDF deleted', storageDeleted: !!storageResult.ok };
    if (!storageResult.ok) response.storageError = storageResult.error;
    return res.json(response);
  } catch (error) {
    console.error('deletePDF error:', error);
    return res.status(500).json({ message: error.message, stack: error.stack });
  }
};
