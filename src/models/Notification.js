const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    lectureId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lecture' },
    videoId: { type: mongoose.Schema.Types.ObjectId, ref: 'Video' },
    chapterId: { type: mongoose.Schema.Types.ObjectId, ref: 'Chapter' },
    instructorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Instructor' },
    materialId: { type: mongoose.Schema.Types.ObjectId, ref: 'Material' },
    thumbnailUrl: { type: String },
    // human-friendly cached titles for display
    chapterTitle: { type: String },
    instructorTitle: { type: String },
    materialTitle: { type: String },
    // If empty array => means broadcast to all users
    recipients: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    // whether this notification is intended only for admin users
    adminOnly: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Notification', notificationSchema);
