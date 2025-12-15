const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    phone: {
      type: String,
      required: true,
    },
    code: {
      type: String,
      required: true,
      unique: true,
    },
    isAdmin: {
      type: Boolean,
      default: false,
    },
    // whether this user is allowed to download videos (admin always allowed)
    canDownloadVideos: {
      type: Boolean,
      default: false,
    },
      // Subscription expiration (null means no subscription / permanent if subscriptionType === 'permanent')
      subscriptionExpires: {
        type: Date,
        default: null,
      },
      subscriptionType: {
        type: String,
        enum: ['none','hour','day','week','month','permanent'],
        default: 'none',
      },
      // Device identifier for single-browser enforcement
      deviceId: {
        type: String,
        default: null,
      },
      // Session token to invalidate old sessions when a new login occurs
      sessionToken: {
        type: String,
        default: null,
      },
      // Support multiple device ids for admins (allow up to 2)
      deviceIds: {
        type: [String],
        default: [],
      },
      // Support multiple session tokens for multi-device sessions (admins)
      sessionTokens: {
        type: [String],
        default: [],
      },
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);
