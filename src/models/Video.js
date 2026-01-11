const mongoose = require('mongoose');

const qualitySchema = new mongoose.Schema({
  quality: { type: String, required: true },
  lastSegmentUrl: { type: String, required: true },
  segmentCount: { type: Number, default: 1 },
});

const videoSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    duration: { type: Number, default: 0 },
    lectureId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lecture', required: true },
    downloadCount: { type: Number, default: 0 },
      qualities: { type: [qualitySchema], default: [] },
      // Video status managed by the centralized Video Status & Monitoring System
      status: { type: String, enum: ['unknown', 'checking', 'working', 'broken'], default: 'unknown' },
      statusUpdatedAt: { type: Date },
      // statusUpdatedAt holds last check time; history removed to avoid large logs
  },
  { timestamps: true }
);

// Video model

module.exports = mongoose.model('Video', videoSchema);
