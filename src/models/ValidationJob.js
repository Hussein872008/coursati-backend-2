const mongoose = require('mongoose');

const videoResultSchema = new mongoose.Schema({
  videoId: { type: mongoose.Schema.Types.ObjectId, ref: 'Video' },
  lectureId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lecture' },
  title: { type: String },
  ok: { type: Boolean, default: false },
  results: { type: mongoose.Schema.Types.Mixed },
  error: { type: String },
  processedAt: { type: Date, default: Date.now },
});

const validationJobSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    status: { type: String, enum: ['queued', 'running', 'finished', 'failed', 'stopped'], default: 'queued' },
    paused: { type: Boolean, default: false },
    startedAt: { type: Date },
    finishedAt: { type: Date },
    totalVideos: { type: Number, default: 0 },
    processedVideos: { type: Number, default: 0 },
    currentVideo: { type: mongoose.Schema.Types.Mixed },
    videos: { type: [videoResultSchema], default: [] },
    error: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ValidationJob', validationJobSchema);
