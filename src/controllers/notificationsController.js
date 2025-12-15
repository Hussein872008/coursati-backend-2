const Notification = require('../models/Notification');

// Get notifications for authenticated user
exports.getNotifications = async (req, res) => {
  try {
    const userId = req.user?._id;
    // Notifications sent to all (recipients empty) or to this user
    const notifications = await Notification.find({
      $or: [
        { recipients: { $size: 0 } },
        { recipients: userId },
      ],
    })
      .sort({ createdAt: -1 })
      .lean();

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
