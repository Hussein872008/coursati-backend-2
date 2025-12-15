const mongoose = require('mongoose');

const lectureViewSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    lectureId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Lecture',
      required: true,
    },
    // videoId field removed - video functionality has been removed from the project
  },
  { timestamps: true }
);

// Prevent duplicate view records per user per lecture
lectureViewSchema.index({ userId: 1, lectureId: 1 }, { unique: true });

module.exports = mongoose.model('LectureView', lectureViewSchema);
