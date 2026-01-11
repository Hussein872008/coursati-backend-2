// Centralized minimal mapping to new Video statuses.
// Returns authoritative status based on `video.status` field when present.
function deriveStatus(video) {
  if (!video) return { status: 'unknown', available: false };
  try {
    const s = (video.status || 'unknown');
    return { status: s, available: s === 'working' };
  } catch (e) {
    return { status: 'unknown', available: false };
  }
}

const STATUSES = ['unknown', 'checking', 'working', 'broken'];

function isAvailableStatus(status) {
  return status === 'working';
}

module.exports = { deriveStatus, STATUSES, isAvailableStatus };
