const Video = require('../models/Video');
const { checkSingleVideo } = require('./videoStatusService');

let _timer = null;
let _running = false;

async function runOnceBatch(limit = 20) {
  if (_running) return;
  _running = true;
  try {
    // pick videos ordered by oldest statusUpdatedAt (or createdAt if never checked)
    const vids = await Video.find().sort({ statusUpdatedAt: 1, createdAt: 1 }).limit(limit).exec();
    for (const v of vids) {
      try { await checkSingleVideo(v); } catch (e) { /* ignore per-video errors */ }
      // small delay between items to avoid bursts
      await new Promise((r) => setTimeout(r, 150));
    }
  } catch (e) {
    console.error('videoStatusScheduler runOnceBatch error', e && e.message);
  } finally {
    _running = false;
  }
}

function startScheduler() {
  const mins = Number(process.env.VIDEO_STATUS_CHECK_INTERVAL_MINS || '30');
  const ms = Math.max(60 * 1000, mins * 60 * 1000);
  // run initial scan shortly after startup
  setTimeout(() => { runOnceBatch(20).catch(() => {}); }, 5000);
  _timer = setInterval(() => { runOnceBatch(20).catch(() => {}); }, ms);
  console.log('Video status scheduler started, interval mins=', mins);
}

function stopScheduler() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}

module.exports = { startScheduler, stopScheduler, runOnceBatch };
