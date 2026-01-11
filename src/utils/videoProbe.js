// Video probe removed by request — provide inert placeholders.
async function probeVideo() { return { ok: false, error: 'probe removed' }; }
async function probeUrlWithRetry() { return { ok: false, error: 'probe removed' }; }
function defaultConstructSegmentUrl(lastUrl) { return lastUrl; }

module.exports = { probeVideo, probeUrlWithRetry, defaultConstructSegmentUrl };
