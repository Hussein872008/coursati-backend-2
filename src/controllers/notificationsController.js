const Notification = require('../models/Notification');

// Get notifications for authenticated user
exports.getNotifications = async (req, res) => {
  try {
    const userId = req.user?._id;
    const isAdmin = !!req.user?.isAdmin;
    // Build query:
    // - If unauthenticated: only non-admin broadcasts
    // - If authenticated non-admin: non-admin broadcasts or explicit recipient
    // - If admin: include adminOnly notifications as well
    let query = null;
    if (!userId) {
      // public: broadcast notifications that are not admin-only and not user-only
      query = { recipients: { $size: 0 }, adminOnly: { $ne: true }, userOnly: { $ne: true } };
    } else if (isAdmin) {
      // admin: receive admin-only, explicit recipients, and broadcasts that are NOT user-only
      query = {
        $or: [
          { adminOnly: true },
          { recipients: { $size: 0 }, userOnly: { $ne: true } },
          { recipients: userId },
        ],
      };
    } else {
      // authenticated non-admin: broadcasts (including userOnly) or explicit recipient
      query = {
        $or: [
          { recipients: { $size: 0 }, adminOnly: { $ne: true } },
          { recipients: userId },
        ],
      };
    }

    const notifications = await Notification.find(query).sort({ createdAt: -1 }).lean();

    // mark read flag per notification for this user
    const result = notifications.map((n) => ({
      ...n,
      isRead: Array.isArray(n.readBy) && n.readBy.some((r) => r.toString() === String(userId)),
    }));

    return res.json(result);
  } catch (err) {
    console.error('getNotifications error', err);
    return res.status(500).json({ message: err.message });
  }
};

// Mark a notification as read for the user
exports.markAsRead = async (req, res) => {
  try {
    const userId = req.user?._id;
    const id = req.params.id;
    const updated = await Notification.findByIdAndUpdate(
      id,
      { $addToSet: { readBy: userId } },
      { new: true }
    );
    if (!updated) return res.status(404).json({ message: 'Notification not found' });
    return res.json({ success: true });
  } catch (err) {
    console.error('markAsRead error', err);
    return res.status(500).json({ message: err.message });
  }
};

// Mark all notifications as read for the authenticated user
exports.markAllRead = async (req, res) => {
  try {
    const userId = req.user?._id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    // Add userId to readBy for all notifications that don't already contain it
    await Notification.updateMany(
      { readBy: { $ne: userId } },
      { $addToSet: { readBy: userId } }
    );
    return res.json({ success: true });
  } catch (err) {
    console.error('markAllRead error', err);
    return res.status(500).json({ message: err.message });
  }
};

// Delete all notifications for the authenticated user (admin only)
exports.deleteAllNotifications = async (req, res) => {
  try {
    const userId = req.user?._id;
    const isAdmin = !!req.user?.isAdmin;
    if (!userId || !isAdmin) return res.status(401).json({ message: 'Unauthorized' });
    
    // Delete all notifications
    const result = await Notification.deleteMany({});
    return res.json({ success: true, deletedCount: result.deletedCount });
  } catch (err) {
    console.error('deleteAllNotifications error', err);
    return res.status(500).json({ message: err.message });
  }
};
