const mongoose = require('mongoose');

const subscriptionLogSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ['hour','day','week','month','permanent'], required: true },
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: false },
    note: { type: String }
  },
  { timestamps: true }
);

module.exports = mongoose.model('SubscriptionLog', subscriptionLogSchema);
