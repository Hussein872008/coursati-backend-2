const User = require('../models/User');
const Notification = require('../models/Notification');
const { generateUserCode } = require('../utils/codeGenerator');
const LectureView = require('../models/LectureView');
const PDFView = require('../models/PDFView');
const SubscriptionLog = require('../models/SubscriptionLog');

// Admin login
exports.adminLogin = async (req, res) => {
  try {
    const { code, deviceId } = req.body;
    const headerDeviceId = req.headers['device-id'] || req.headers['device_id'];
    const effectiveDeviceId = deviceId || headerDeviceId || null;
    const adminCode = process.env.ADMIN_CODE;

    if (code !== adminCode) {
      return res.status(401).json({ message: 'Invalid admin code' });
    }

    // Find or create admin user
    let admin = await User.findOne({ isAdmin: true });
    if (!admin) {
      const createObj = {
        name: 'Admin',
        phone: '0000000000',
        code: adminCode,
        isAdmin: true,
        subscriptionType: 'permanent',
        subscriptionExpires: null,
      };
      if (effectiveDeviceId) createObj.deviceId = effectiveDeviceId;
      admin = await User.create(createObj);
    } else {
      // Update existing admin to ensure permanent subscription
      admin = await User.findByIdAndUpdate(
        admin._id,
        { subscriptionType: 'permanent', subscriptionExpires: null },
        { new: true }
      );
    }

    // Enforce single-browser for admin as well

    // Support up to 3 admin devices: normalize legacy field to array
    admin.deviceIds = Array.isArray(admin.deviceIds) && admin.deviceIds.length > 0
      ? admin.deviceIds
      : (admin.deviceId ? [admin.deviceId] : []);
    admin.sessionTokens = Array.isArray(admin.sessionTokens) && admin.sessionTokens.length > 0
      ? admin.sessionTokens
      : (admin.sessionToken ? [admin.sessionToken] : []);

    if (effectiveDeviceId) {
      if (!admin.deviceIds.includes(effectiveDeviceId)) {
        const ADMIN_DEVICE_LIMIT = Number(process.env.ADMIN_SESSION_LIMIT || '3');
        if (admin.deviceIds.length >= ADMIN_DEVICE_LIMIT) {
          try {
            await Notification.create({
              title: 'محاولة دخول على حساب المدير من متصفح آخر',
              recipients: [admin._id],
            });
          } catch (e) {
            // ignore notification errors
          }
          return res.status(403).json({ message: `Admin already logged in on ${ADMIN_DEVICE_LIMIT - 1} other browsers` });
        }
        admin.deviceIds.push(effectiveDeviceId);
      }
    }

    // Bind device and generate a fresh session token (support multiple tokens for admin)
    const crypto = require('crypto');
    const newSessionToken = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    admin.sessionTokens = admin.sessionTokens || [];
    admin.sessionTokens.push(newSessionToken);
    // keep sessionTokens size capped (ADMIN_SESSION_LIMIT)
    const ADMIN_SESSION_LIMIT = Number(process.env.ADMIN_SESSION_LIMIT || '3');
    if (admin.sessionTokens.length > ADMIN_SESSION_LIMIT) admin.sessionTokens = admin.sessionTokens.slice(-ADMIN_SESSION_LIMIT);

    // keep legacy fields for backwards compat (first values)
    if (!admin.deviceId && admin.deviceIds.length > 0) admin.deviceId = admin.deviceIds[0];
    admin.sessionToken = newSessionToken;
    try { await admin.save(); } catch (e) { /* non-fatal */ }

    return res.json({ message: 'Admin logged in', user: admin });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// User login
exports.userLogin = async (req, res) => {
  try {
    const { code, deviceId } = req.body;
    // allow device id to come from header as well
    const headerDeviceId = req.headers['device-id'] || req.headers['device_id'];
    const effectiveDeviceId = deviceId || headerDeviceId || null;

    const user = await User.findOne({ code, isAdmin: false });
    if (!user) {
      return res.status(401).json({ message: 'Invalid user code' });
    }

    // Enforce single-browser: if user already has a deviceId set and it's different, deny login
    if (user.deviceId && effectiveDeviceId && user.deviceId !== effectiveDeviceId) {
      try {
        await Notification.create({
          title: 'محاولة دخول من متصفح آخر',
          recipients: [user._id],
        });
      } catch (e) {
        // ignore notification errors
      }
      return res.status(403).json({ message: 'User already logged in on another browser' });
    }

    // If user has no deviceId, bind this login to the provided deviceId (if provided)
    // Bind device and generate a fresh session token
    const crypto = require('crypto');
    const newSessionToken = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');

    if (!user.deviceId && effectiveDeviceId) {
      user.deviceId = effectiveDeviceId;
    }
    user.sessionToken = newSessionToken;
    try { await user.save(); } catch (e) { /* non-fatal */ }

    // Check subscription expiry: permanent always allowed
    if (user.subscriptionType !== 'permanent') {
      const now = new Date();
      if (!user.subscriptionExpires || new Date(user.subscriptionExpires) < now) {
        return res.status(403).json({ message: 'Subscription expired' });
      }
    }

    return res.json({ message: 'User logged in', user });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Create user (admin only)
exports.createUser = async (req, res) => {
  try {
    const { name, phone, subscriptionType } = req.body;

    if (!name || !phone) {
      return res.status(400).json({ message: 'Name and phone required' });
    }

    // determine subscription expiration based on optional subscriptionType
    const now = new Date();
    let subscriptionExpires = null;
    let subType = 'none';
    if (subscriptionType) {
      subType = subscriptionType;
      switch (subscriptionType) {
        case 'hour':
          subscriptionExpires = new Date(now.getTime() + 1 * 60 * 60 * 1000);
          break;
        case 'day':
          subscriptionExpires = new Date(now.getTime() + 24 * 60 * 60 * 1000);
          break;
        case 'week':
          subscriptionExpires = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
          break;
        case 'month':
          subscriptionExpires = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
          break;
        case 'permanent':
          subscriptionExpires = null;
          break;
        default:
          subType = 'none';
      }
    }

    const code = generateUserCode();
    const user = await User.create({
      name,
      phone,
      code,
      isAdmin: false,
      subscriptionType: subType,
      subscriptionExpires,
    });

    return res.status(201).json({ message: 'User created', user });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: 'User code already exists' });
    }
    return res.status(500).json({ message: error.message });
  }
};

// Get all users (admin only)
exports.getAllUsers = async (req, res) => {
  try {
    const users = await User.find({ isAdmin: false });
    return res.json(users);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Get user by ID
exports.getUserById = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    return res.json(user);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Update user (admin only) - allow updating basic fields and permissions
exports.updateUser = async (req, res) => {
  try {
    const { name, phone, canDownloadVideos } = req.body;

    const updateObj = {};
    if (typeof name !== 'undefined') updateObj.name = name;
    if (typeof phone !== 'undefined') updateObj.phone = phone;
    if (typeof canDownloadVideos !== 'undefined') updateObj.canDownloadVideos = !!canDownloadVideos;

    const user = await User.findByIdAndUpdate(
      req.params.id,
      updateObj,
      { new: true }
    );

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    return res.json({ message: 'User updated', user });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Update subscription (admin only)
// PUT /auth/users/:id/subscription
exports.updateSubscription = async (req, res) => {
  try {
    const { type } = req.body; // expected: 'hour'|'day'|'week'|'month'|'permanent'
    if (!type) return res.status(400).json({ message: 'Subscription type required' });

    const now = new Date();
    let expires = null;

    // load current user to allow extending from existing expiry
    const existing = await User.findById(req.params.id).select('subscriptionExpires');
    const base = (existing && existing.subscriptionExpires && new Date(existing.subscriptionExpires) > now)
      ? new Date(existing.subscriptionExpires)
      : now;

    switch (type) {
      case 'hour':
        expires = new Date(base.getTime() + 1 * 60 * 60 * 1000);
        break;
      case 'day':
        expires = new Date(base.getTime() + 24 * 60 * 60 * 1000);
        break;
      case 'week':
        expires = new Date(base.getTime() + 7 * 24 * 60 * 60 * 1000);
        break;
      case 'month':
        // approx 30 days
        expires = new Date(base.getTime() + 30 * 24 * 60 * 60 * 1000);
        break;
      case 'permanent':
        expires = null;
        break;
      default:
        return res.status(400).json({ message: 'Invalid subscription type' });
    }

    const update = { subscriptionType: type, subscriptionExpires: expires };

    const user = await User.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!user) return res.status(404).json({ message: 'User not found' });

    // record subscription change in log
    try {
      await SubscriptionLog.create({ userId: user._id, type, adminId: req.user ? req.user._id : undefined });
    } catch (e) {
      console.error('Failed to create subscription log', e);
    }

    return res.json({ message: 'Subscription updated', user });
  } catch (err) {
    console.error('updateSubscription error', err);
    return res.status(500).json({ message: err.message });
  }
};

// Get user history: views (lectures/pdfs) and subscription logs
exports.getUserHistory = async (req, res) => {
  try {
    const userId = req.params.id;

    // Video views removed - video functionality has been removed from the project
    const lectureViews = await LectureView.find({ userId }).populate({ path: 'lectureId', select: 'title' }).sort({ createdAt: -1 }).limit(200);
    const pdfViews = await PDFView.find({ userId }).populate({ path: 'pdfId', select: 'title' }).sort({ createdAt: -1 }).limit(200);

    const subs = await SubscriptionLog.find({ userId }).sort({ createdAt: -1 }).limit(200);

    return res.json({ lectureViews, pdfViews, subscriptions: subs });
  } catch (err) {
    console.error('getUserHistory error', err);
    return res.status(500).json({ message: err.message });
  }
};

// Delete user (admin only)
exports.deleteUser = async (req, res) => {
  try {
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    return res.json({ message: 'User deleted' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Reset device binding so the user can login from another browser (admin only)
exports.resetDevice = async (req, res) => {
  try {
    const userId = req.params.id;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (user.isAdmin) {
      user.deviceIds = [];
      user.sessionTokens = [];
      user.deviceId = null;
      user.sessionToken = null;
    } else {
      user.deviceId = null;
      user.sessionToken = null; // invalidate existing session tokens
    }
    await user.save();

    return res.json({ message: 'Device reset', user });
  } catch (err) {
    console.error('resetDevice error', err);
    return res.status(500).json({ message: err.message });
  }
};
