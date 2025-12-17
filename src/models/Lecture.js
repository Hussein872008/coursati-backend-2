const mongoose = require('mongoose');

const lectureSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
    },
    chapterId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Chapter',
      required: true,
    },
    // URL for lecture thumbnail (Cloudinary or external)
    thumbnailUrl: { type: String },
    // legacy field: allow storing direct thumbnail string if used elsewhere
    thumbnail: { type: String },
    pdfs: [
      {
        url: { type: String },
        name: { type: String },
        uploadedAt: { type: Date, default: Date.now },
      }
    ],
    viewCount: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Lecture', lectureSchema);
