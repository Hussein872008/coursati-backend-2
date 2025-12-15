const mongoose = require('mongoose');

const pdfSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
    },
    lectureId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Lecture',
      required: true,
    },
    fileUrl: {
      type: String,
      required: true,
    },
    viewCount: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PDF', pdfSchema);
