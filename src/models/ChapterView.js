const mongoose = require('mongoose');

const chapterViewSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    chapterId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Chapter',
      required: true,
    },
    // videoId field removed - video functionality has been removed from the project
  },
  { timestamps: true }
);

// Prevent duplicate view records per user per chapter
chapterViewSchema.index({ userId: 1, chapterId: 1 }, { unique: true });

module.exports = mongoose.model('ChapterView', chapterViewSchema);
