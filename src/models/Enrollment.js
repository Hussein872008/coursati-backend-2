const mongoose = require('mongoose');

const enrollmentSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    materialId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Material',
      required: true,
    },
  },
  { timestamps: true }
);

// prevent duplicate enrollment per user+material
enrollmentSchema.index({ userId: 1, materialId: 1 }, { unique: true });

module.exports = mongoose.model('Enrollment', enrollmentSchema);
