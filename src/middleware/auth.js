// Check if request has a valid user token
const authMiddleware = async (req, res, next) => {
  // allow user code to come from header or query param (for browser downloads)
  const userCode = req.headers['user-code'] || req.query.userCode || req.query['user-code'];
  // DEBUG: log incoming header for diagnosis (remove in production)

  // device id header used to enforce single-browser usage
  const deviceId = req.headers['device-id'] || req.headers['device_id'] || req.query.deviceId || req.query['device-id'];
  // session token header used to validate active session
  const sessionToken = req.headers['session-token'] || req.headers['session_token'];
  
  if (!userCode) {
    return res.status(401).json({ message: 'User code required' });
  }

  const User = require('../models/User');
  try {
    const user = await User.findOne({ code: userCode });
    // DEBUG: show whether user was found (remove in production)
    if (!user) {
      return res.status(401).json({ message: 'Invalid user code' });
    }
    // normalize device ids and session tokens (support legacy single-field)
    const userDeviceIds = Array.isArray(user.deviceIds) && user.deviceIds.length > 0
      ? user.deviceIds
      : (user.deviceId ? [user.deviceId] : []);
    const userSessionTokens = Array.isArray(user.sessionTokens) && user.sessionTokens.length > 0
      ? user.sessionTokens
      : (user.sessionToken ? [user.sessionToken] : []);

    // If user has registered device ids, require the incoming deviceId to be one of them
    if (userDeviceIds.length > 0 && deviceId && !userDeviceIds.includes(deviceId)) {
      return res.status(403).json({ message: 'Access denied: user bound to a different device' });
    }

    // If user has session tokens, require the incoming sessionToken to be one of them
    if (userSessionTokens.length > 0 && sessionToken && !userSessionTokens.includes(sessionToken)) {
      return res.status(403).json({ message: 'Access denied: session invalidated' });
    }
    req.user = user;
    next();
  } catch (error) {
    return res.status(500).json({ message: 'Auth error' });
  }
};


// Check if user is admin
const adminMiddleware = (req, res, next) => {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ message: 'Admin access only' });
  }
  next();
};

// Optional auth: if `user-code` header present, set `req.user`; otherwise continue anonymously
const optionalAuth = async (req, res, next) => {
  const userCode = req.headers['user-code'] || req.query.userCode || req.query['user-code'];
  const deviceId = req.headers['device-id'] || req.headers['device_id'] || req.query.deviceId || req.query['device-id'];
  const sessionToken = req.headers['session-token'] || req.headers['session_token'] || req.query.sessionToken || req.query['session-token'];
  if (!userCode) {
    return next();
  }

  const User = require('../models/User');
  try {
    const user = await User.findOne({ code: userCode });
    if (user) {
      const userDeviceIds = Array.isArray(user.deviceIds) && user.deviceIds.length > 0
        ? user.deviceIds
        : (user.deviceId ? [user.deviceId] : []);
      const userSessionTokens = Array.isArray(user.sessionTokens) && user.sessionTokens.length > 0
        ? user.sessionTokens
        : (user.sessionToken ? [user.sessionToken] : []);

      if (userDeviceIds.length > 0 && deviceId && !userDeviceIds.includes(deviceId)) {
        // do not attach user if device doesn't match
      } else if (userSessionTokens.length > 0 && sessionToken && !userSessionTokens.includes(sessionToken)) {
        // do not attach user if session token invalid
      } else {
        req.user = user;
      }
    }
  } catch (error) {
    // optionalAuth error (suppressed in production logs)
  }
  return next();
};

module.exports = {
  authMiddleware,
  adminMiddleware,
  optionalAuth,
};

// Middleware to ensure the authenticated user's subscription/code is not expired
const checkSubscription = (req, res, next) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ message: 'User required' });
    }

    // Permanent subscriptions always allowed
    if (user.subscriptionType === 'permanent') {
      return next();
    }

    // If there's no expiration date or it's in the past, deny access
    if (!user.subscriptionExpires) {
      return res.status(403).json({ message: 'Subscription expired' });
    }

    const now = new Date();
    const expires = new Date(user.subscriptionExpires);
    if (expires < now) {
      return res.status(403).json({ message: 'Subscription expired' });
    }

    return next();
  } catch (err) {
    return res.status(500).json({ message: 'Subscription check error' });
  }
};

module.exports = {
  authMiddleware,
  adminMiddleware,
  optionalAuth,
  checkSubscription,
};
