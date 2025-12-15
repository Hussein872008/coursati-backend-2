const mongoose = require('mongoose');

const videoViewSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    videoId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Video',
      required: true,
    },
  },
  { timestamps: true }
);

// Prevent duplicate view records per user per video
videoViewSchema.index({ userId: 1, videoId: 1 }, { unique: true });

module.exports = mongoose.model('VideoView', videoViewSchema);
