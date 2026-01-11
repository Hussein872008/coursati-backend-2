// Simple Server-Sent Events (SSE) notification bus stub.
// Keeps a set of response objects so `server.js` can register clients
// and close them on shutdown. Minimal implementation to avoid "module not found"
// warnings in development if the real notification bus isn't present.

// clients: Set of { res, userId, isAdmin }
const NOTIF_DEBUG = (() => { const v = process.env.VIDEO_STATUS_DEBUG || process.env.NOTIFICATION_BUS_DEBUG; return v === '1' || v === 'true' || v === 'yes'; })();
function dbg(...args) { if (NOTIF_DEBUG) console.info(...args); }
const clients = new Set();

function addClient(res, meta = {}) {
  try {
    const entry = { res, userId: meta.userId || null, isAdmin: !!meta.isAdmin };
    clients.add(entry);
    // Ensure we clean up when the connection closes
    res.on && res.on('close', () => clients.delete(entry));
  } catch (e) {
    // ignore
  }
}

function removeClient(res) {
  try {
    for (const entry of Array.from(clients)) {
      if (entry.res === res) clients.delete(entry);
    }
  } catch (e) {}
}

function closeAll() {
  for (const entry of Array.from(clients)) {
    try {
      entry.res.end && entry.res.end();
    } catch (e) {
      // ignore errors while closing
    }
  }
  clients.clear();
}

// Decide whether to send a notification to a given client
function shouldSendToClient(entry, notif) {
  // notif: { recipients: [], adminOnly?, userOnly? }
  const recipients = Array.isArray(notif.recipients) ? notif.recipients : [];
  // explicit recipients
  if (recipients.length > 0) {
    if (!entry.userId) return false;
    return recipients.some(r => String(r) === String(entry.userId));
  }

  // broadcast
  if (notif.adminOnly) return !!entry.isAdmin;
  if (notif.userOnly) return !!entry.userId && !entry.isAdmin;
  return true; // public broadcast
}

// Send a notification to connected SSE clients (filtered per-client)
function sendNotification(obj) {
  try {
    const notif = typeof obj === 'string' ? { title: obj } : obj;
    const payload = JSON.stringify(notif);
    let sentCount = 0;
    const clientCount = clients.size;
    for (const entry of Array.from(clients)) {
      try {
        if (!shouldSendToClient(entry, notif)) continue;
        const res = entry.res;
        if (res.write) {
          res.write(`data: ${payload}\n\n`);
          sentCount += 1;
        }
      } catch (e) {
        try { entry.res.end && entry.res.end(); } catch (er) {}
        clients.delete(entry);
      }
    }
    try { dbg('notificationBus: sendNotification', notif && notif.title, 'clients', clientCount, 'sent', sentCount); } catch (e) {}
  } catch (e) {
    // ignore
  }
}

module.exports = { addClient, removeClient, closeAll, sendNotification };
