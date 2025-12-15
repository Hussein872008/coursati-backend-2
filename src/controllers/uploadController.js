const fs = require('fs');
const { uploadPdf } = require('../utils/supabasePdf');

// POST /api/uploads/pdf
exports.uploadPdf = async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    // Validate MIME type
    if (file.mimetype !== 'application/pdf') {
      // remove temp file
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      return res.status(400).json({ message: 'Only PDF files are allowed' });
    }

    // Upload to Supabase
    try {
      const publicUrl = await uploadPdf(file.path, file.originalname);
      // remove temp file
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      return res.json({ pdfUrl: publicUrl });
    } catch (err) {
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      console.error('Supabase upload error:', err);
      // If it's a bucket-not-found related error, return 400 with helpful message
      const msg = err.message || (err.original && err.original.message) || 'Upload failed';
      if (msg.toLowerCase().includes('bucket')) {
        return res.status(400).json({ message: `Supabase storage error: ${msg}. Ensure bucket 'pdfs' exists and SUPABASE keys are correct.` });
      }
      return res.status(500).json({ message: 'Upload failed', error: msg });
    }
  } catch (error) {
    console.error('uploadPdf controller error:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
};
