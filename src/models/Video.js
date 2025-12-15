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
  },
  { timestamps: true }
);

module.exports = mongoose.model('Video', videoSchema);
