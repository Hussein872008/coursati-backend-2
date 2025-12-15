const mongoose = require('mongoose');

const pdfViewSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    pdfId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PDF',
      required: true,
    },
  },
  { timestamps: true }
);

// Prevent duplicate view records per user per pdf
pdfViewSchema.index({ userId: 1, pdfId: 1 }, { unique: true });

module.exports = mongoose.model('PDFView', pdfViewSchema);
