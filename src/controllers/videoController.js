const Video = require('../models/Video');
const Lecture = require('../models/Lecture');
const Chapter = require('../models/Chapter');
const Notification = require('../models/Notification');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const gridfs = require('../utils/gridfs');
const ValidationJob = require('../models/ValidationJob');

// Helper: optionally POST job summary to a configured webhook when job finishes/fails/stops
async function sendValidationWebhook(jobRecord) {
  try {
    const webhook = process.env.VIDEO_VALIDATION_WEBHOOK;
    if (!webhook) return;
    // allow threshold: only send when failures >= threshold (default 1)
    const minFails = parseInt(process.env.VIDEO_VALIDATION_WEBHOOK_MIN_FAILS || '1', 10) || 1;
    const totalFailed = (jobRecord && jobRecord.videos && jobRecord.videos.reduce((acc, v) => acc + ((v && v.ok) ? 0 : 1), 0)) || 0;
    if (totalFailed < minFails) return;
    const payload = {
      id: jobRecord.id || jobRecord._id,
      status: jobRecord.status,
      totalVideos: jobRecord.totalVideos || (jobRecord.videos && jobRecord.videos.length) || 0,
      processedVideos: jobRecord.processedVideos || (jobRecord.videos && jobRecord.videos.length) || 0,
      totalFailed,
      finishedAt: jobRecord.finishedAt || new Date(),
    };
    // fire-and-forget with short timeout
    await axios.post(webhook, payload, { timeout: 5000 }).catch(() => {});
  } catch (e) {
    // swallow webhook errors
    try { console.warn('sendValidationWebhook failed', e && (e.message || e)); } catch (er) {}
  }
}

const signSecret = process.env.VIDEO_SIGN_SECRET || process.env.JWT_SECRET;

function parseTtlToSeconds(ttl) {
  if (!ttl) return 120;
  if (typeof ttl === 'number') return Math.max(1, Math.floor(ttl));
  if (typeof ttl === 'string') {
    const s = ttl.trim();
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    if (s.endsWith('s')) return parseInt(s.slice(0, -1), 10) || 120;
    if (s.endsWith('m')) return (parseInt(s.slice(0, -1), 10) || 2) * 60;
    if (s.endsWith('h')) return (parseInt(s.slice(0, -1), 10) || 1) * 3600;
  }
  return 120;
}

// Simple in-memory playlist cache: { key: { expires: ts, body: string } }
const playlistCache = new Map();

function setPlaylistCache(key, body, ttlSeconds = 30) {
  playlistCache.set(key, { body, expires: Date.now() + ttlSeconds * 1000 });
}

function getPlaylistCache(key) {
  const rec = playlistCache.get(key);
  if (!rec) return null;
  if (Date.now() > rec.expires) { playlistCache.delete(key); return null; }
  return rec.body;
}

function estimateSegmentCountFromUrl(url) {
  if (!url || typeof url !== 'string') return 1;
  try {
    // Find all digit groups in the filename and pick the largest (handles names like segment-41-v1-a1.ts)
    const parts = url.split('/');
    const last = parts[parts.length - 1];
    const matches = last.match(/\d+/g);
    if (matches && matches.length > 0) {
      const nums = matches.map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
      if (nums.length > 0) return Math.max(...nums);
    }
  } catch (err) {
    // ignore
  }
  return 1;
}

// Admin: create video for lecture
exports.createVideo = async (req, res) => {
  try {
    const { title, duration, qualities } = req.body;
    const { lectureId } = req.params;

    if (!title || !lectureId || !qualities) {
      return res.status(400).json({ message: 'title, lectureId and qualities are required' });
    }

    let parsedQualities = [];
    try {
      parsedQualities = typeof qualities === 'string' ? JSON.parse(qualities) : qualities;
    } catch (err) {
      return res.status(400).json({ message: 'Invalid qualities JSON' });
    }

    const normalized = parsedQualities.map((q) => {
      const lastSegmentUrl = q.lastSegmentUrl || q.last_segment_url || q.url || '';
      const segmentCount = estimateSegmentCountFromUrl(lastSegmentUrl) || (q.segmentCount || 1);
      return { quality: String(q.quality || q.q || ''), lastSegmentUrl, segmentCount };
    });

    const video = await Video.create({ title, duration: Number(duration) || 0, lectureId, qualities: normalized });

    try {
      await Lecture.findByIdAndUpdate(lectureId, { $push: { videos: { id: video._id, title: video.title, createdAt: new Date() } } });
    } catch (pushErr) {
      // not fatal - suppressed warning
    }

    return res.status(201).json(video);
  } catch (err) {
    console.error('createVideo error', err);
    return res.status(500).json({ message: err.message });
  }
};

// Public: get videos by lecture
exports.getVideosByLecture = async (req, res) => {
  try {
    const { lectureId } = req.params;
    const videos = await Video.find({ lectureId }).sort({ createdAt: 1 });
    return res.json(videos);
  } catch (err) {
    console.error('getVideosByLecture error', err);
    return res.status(500).json({ message: err.message });
  }
};

// Public: quick availability check for a lecture's videos.
// Returns { ok:true, total, broken, perVideo: [{ videoId, available }] }
exports.getLectureAvailabilityPublic = async (req, res) => {
  try {
    const { lectureId } = req.params;
    const videos = await Video.find({ lectureId }).sort({ createdAt: 1 });
    const https = require('https');
    const allowInsecure = String(process.env.VIDEO_ALLOW_INSECURE_UPSTREAM || '').toLowerCase() === 'true';
    const baseCfg = {};
    if (allowInsecure) baseCfg.httpsAgent = new https.Agent({ rejectUnauthorized: false });
    const AXIOS_TIMEOUT = parseInt(process.env.VIDEO_VALIDATE_TIMEOUT_MS || '3000', 10);

    const results = [];
    const CONCURRENCY = 6;
    for (let i = 0; i < videos.length; i += CONCURRENCY) {
      const batch = videos.slice(i, i + CONCURRENCY);
      const promises = batch.map(async (v) => {
        const q = (Array.isArray(v.qualities) && v.qualities[0]) || null;
        const url = q && (q.lastSegmentUrl || q.url);
        if (!url) return { videoId: v._id, available: false };
        try {
          const cfg = { ...baseCfg, timeout: AXIOS_TIMEOUT };
          try {
            const head = await axios.head(url, cfg);
            if (head && head.status && head.status < 400) return { videoId: v._id, available: true };
          } catch (he) {
            // fall through to GET
          }
          const getcfg = { ...baseCfg, timeout: AXIOS_TIMEOUT, responseType: 'arraybuffer' };
          const g = await axios.get(url, getcfg);
          if (g && g.status && g.status < 400) return { videoId: v._id, available: true };
        } catch (err) {
          // unavailable
        }
        return { videoId: v._id, available: false };
      });
      const settled = await Promise.all(promises);
      results.push(...settled);
    }

    const total = results.length;
    const broken = results.filter((r) => !r.available).length;
    return res.json({ ok: true, total, broken, perVideo: results });
  } catch (err) {
    console.error('getLectureAvailabilityPublic error', err && (err.stack || err.message));
    return res.status(500).json({ message: 'availability check failed' });
  }
};

// Sign a single segment request (short lived token)
exports.signSegment = async (req, res) => {
  try {
    const { videoId } = req.params;
    const { quality, segmentNumber } = req.body;
    if (!quality || typeof segmentNumber === 'undefined') {
      return res.status(400).json({ message: 'quality and segmentNumber required' });
    }
    const ttl = process.env.VIDEO_SEGMENT_TOKEN_TTL || '2m';
    const ttlSeconds = parseTtlToSeconds(ttl);
    const token = jwt.sign({ videoId, quality, segmentNumber }, signSecret, { expiresIn: ttlSeconds });
    return res.json({ token, expiresIn: ttlSeconds });
  } catch (err) {
    console.error('signSegment error', err);
    return res.status(500).json({ message: err.message });
  }
};

// Generate an HLS playlist (m3u8) with signed URLs for each segment
exports.playlist = async (req, res) => {
  try {
    const { videoId, quality } = req.params;
    const cacheKey = `${videoId}:${quality}`;
    const cached = getPlaylistCache(cacheKey);
    if (cached) {
      res.setHeader('content-type', 'application/vnd.apple.mpegurl');
      return res.send(cached);
    }
    const video = await Video.findById(videoId);
    if (!video) return res.status(404).send('video not found');
    const q = video.qualities.find((x) => String(x.quality) === String(quality));
    if (!q) return res.status(404).send('quality not found');

    // Determine segmentCount with priority:
    // 1) explicit q.segmentCount (>1)
    // 2) estimate from lastSegmentUrl if it looks correct
    // 3) derive from stored video.duration using a default segment length
    const vidDuration = Number(video.duration) || 0;
    const defaultSegLen = Number(process.env.DEFAULT_SEGMENT_DURATION || 6); // seconds per segment when deriving from duration
    let segmentCount = (q.segmentCount && q.segmentCount > 1) ? q.segmentCount : 0;
    if (!segmentCount) {
      const est = estimateSegmentCountFromUrl(q.lastSegmentUrl || q.last_segment_url || q.url || '');
      if (est && est > 1) segmentCount = est;
    }
    if ((!segmentCount || segmentCount < 1) && vidDuration > 0) {
      segmentCount = Math.max(1, Math.ceil(vidDuration / Math.max(1, defaultSegLen)));
    }
    if (!segmentCount || segmentCount < 1) segmentCount = 1;

    // Build per-segment durations using the canonical video duration from DB when available.
    // This produces EXTINF values that sum to the known duration (with 3-decimal precision) and
    // sets EXT-X-TARGETDURATION to the ceiling of the longest segment.
    const segmentDurations = [];
    if (vidDuration > 0 && segmentCount > 0) {
      const per = vidDuration / segmentCount;
      for (let i = 0; i < segmentCount; i++) segmentDurations.push(Number(per.toFixed(3)));
      // adjust last segment to make the sum equal to vidDuration (prevent tiny rounding drift)
      const sum = segmentDurations.reduce((a, b) => a + b, 0);
      const diff = Number((vidDuration - sum).toFixed(3));
      if (Math.abs(diff) > 0.0005) {
        segmentDurations[segmentCount - 1] = Number((segmentDurations[segmentCount - 1] + diff).toFixed(3));
      }
    } else {
      // fallback: 1s segments
      for (let i = 0; i < Math.max(1, segmentCount); i++) segmentDurations.push(1);
    }

    const maxSegDur = Math.max(...segmentDurations, 1);
    const targetDur = Math.ceil(maxSegDur);

    // Build m3u8
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-PLAYLIST-TYPE:VOD', `#EXT-X-TARGETDURATION:${targetDur}`, '#EXT-X-MEDIA-SEQUENCE:1'];

    // Decide per-segment token TTL. Ensure it's at least long enough to cover playlist playback plus a safety margin.
    const configuredTtl = process.env.VIDEO_SEGMENT_TOKEN_TTL || '2m';
    const configuredSeconds = parseTtlToSeconds(configuredTtl);
    const playlistSeconds = Math.max(1, Math.ceil(vidDuration) || (targetDur * segmentCount));
    const segTtlSeconds = Math.max(configuredSeconds, playlistSeconds + 30);
    for (let i = 1; i <= segmentCount; i++) {
      // sign tokens valid for segTtlSeconds
      const token = jwt.sign({ videoId, quality, segmentNumber: i }, signSecret, { expiresIn: segTtlSeconds });
      const segUrl = `/api/videos/${videoId}/segments/${quality}/${i}?token=${encodeURIComponent(token)}`;
      const dur = segmentDurations[i - 1] || 1;
      lines.push(`#EXTINF:${dur},`);
      lines.push(segUrl);
    }

    lines.push('#EXT-X-ENDLIST');

    const body = lines.join('\n');
    // cache briefly
    setPlaylistCache(cacheKey, body, 20);
    // expose video duration and playlist total for debugging (helps verify DB value is used)
    try {
      res.setHeader('x-video-duration', String(vidDuration));
      const totalFromSegments = segmentDurations.reduce((a, b) => a + b, 0);
      res.setHeader('x-playlist-total-seconds', String(Number(totalFromSegments.toFixed(3))));
      // prepend a comment to the playlist body with debug info (players ignore comments)
      const debugComment = `# DB_DURATION:${vidDuration} TOTAL_SEGMENTS_SUM:${Number(totalFromSegments.toFixed(3))}`;
      const bodyWithComment = debugComment + '\n' + body;
      res.setHeader('content-type', 'application/vnd.apple.mpegurl');
      return res.send(bodyWithComment);
    } catch (e) {
      res.setHeader('content-type', 'application/vnd.apple.mpegurl');
      return res.send(body);
    }
  } catch (err) {
    console.error('playlist error', err);
    return res.status(500).send('playlist error');
  }
};

// Proxy a segment securely (requires token)
exports.proxySegment = async (req, res) => {
  try {
    const { videoId, quality, segmentNumber } = req.params;
    const token = req.query.token || req.headers['x-seg-token'];
    if (!token) return res.status(401).send('token required');
    let payload = null;
    try {
      // allow small clock skew tolerance
      payload = jwt.verify(token, signSecret, { clockTolerance: 5 });
    } catch (err) {
      // token verify failed -> provide diagnostics in non-production
      const decoded = (() => {
        try { return jwt.decode(token); } catch (e) { return null; }
      })();
      console.warn('[proxySegment] token verify failed', err && err.message, 'decoded:', decoded);
      if (String(process.env.NODE_ENV || '').toLowerCase() !== 'production') {
        return res.status(403).json({ message: 'invalid token', error: err && err.message, decoded });
      }
      return res.status(403).send('invalid token');
    }
    if (!payload || payload.videoId !== videoId || payload.quality !== quality || Number(payload.segmentNumber) !== Number(segmentNumber)) {
      const decoded = jwt.decode(token);
      console.warn('[proxySegment] token payload mismatch', { payload, expected: { videoId, quality, segmentNumber }, decoded });
      if (String(process.env.NODE_ENV || '').toLowerCase() !== 'production') {
        return res.status(403).json({ message: 'invalid token', payload, expected: { videoId, quality, segmentNumber }, decoded });
      }
      return res.status(403).send('invalid token');
    }

    // Lookup the video and quality URL
    const video = await Video.findById(videoId);
    if (!video) return res.status(404).send('video not found');
    const q = video.qualities.find((x) => String(x.quality) === String(quality));
    if (!q) return res.status(404).send('quality not found');

    // Construct segment url by replacing the numeric group most likely representing the segment index
    let upstream = q.lastSegmentUrl;
    const parts = upstream.split('/');
    const last = parts.pop();

    // Find all numeric groups with their positions
    const matches = [...last.matchAll(/\d+/g)];
    let newLast = last;
    if (matches && matches.length > 0) {
      // choose the numeric group with the largest numeric value (likely the segment index like 41 in segment-41-v1-a1)
      let best = matches[0];
      for (const mmm of matches) {
        if (parseInt(mmm[0], 10) > parseInt(best[0], 10)) best = mmm;
      }
      const digits = best[0];
      const idx = best.index;
      const padded = String(segmentNumber).padStart(digits.length, '0');
      newLast = last.slice(0, idx) + padded + last.slice(idx + digits.length);
    } else {
      // fallback: append segmentNumber before ext or at end
      const mm = last.match(/(\.[^.]+)$/);
      if (mm) newLast = last.replace(mm[1], `_${segmentNumber}${mm[1]}`);
      else newLast = `${last}_${segmentNumber}`;
    }
    parts.push(newLast);
    const finalUrl = parts.join('/');

    // Try to serve from GridFS first (if mirrored there)
    try {
      const gridFilename = `videos/${videoId}/${quality}/${newLast}`;
      const gf = await gridfs.findFileByName(gridFilename);
      if (gf) {
        const ds = gridfs.openDownloadStreamById(gf._id);
        res.setHeader('content-type', gf.contentType || 'application/octet-stream');
        ds.pipe(res);
        return;
      }
    } catch (e) {
      // ignore GridFS errors and fall back to upstream
    }

    // Proxy the request to upstream if not found in GridFS
    // Allow disabling upstream TLS verification via env VIDEO_ALLOW_INSECURE_UPSTREAM=true
    const allowInsecure = String(process.env.VIDEO_ALLOW_INSECURE_UPSTREAM || '').toLowerCase() === 'true';
    const https = require('https');
    const axiosConfig = { responseType: 'stream' };
    if (allowInsecure) {
      axiosConfig.httpsAgent = new https.Agent({ rejectUnauthorized: false });
    }
    // Try fetching with retries
    const maxAttempts = 3;
    let attempt = 0;
    let lastErr = null;
    for (; attempt < maxAttempts; attempt++) {
      try {
        const upstreamRes = await axios.get(finalUrl, axiosConfig);
        res.setHeader('content-type', upstreamRes.headers['content-type'] || 'application/octet-stream');
        upstreamRes.data.pipe(res);
        return;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
    }
    console.error('[proxySegment] all attempts failed for', finalUrl, 'lastErr:', lastErr && (lastErr.message || lastErr));
    // Provide additional diagnostic info in non-production to help debugging
    if (String(process.env.NODE_ENV || '').toLowerCase() !== 'production') {
      const errMsg = lastErr && (lastErr.message || (lastErr.response && lastErr.response.statusText) || String(lastErr));
      return res.status(502).json({ message: 'upstream fetch failed', url: finalUrl, error: errMsg });
    }
    return res.status(502).send('upstream fetch failed');
  } catch (err) {
    console.error('proxySegment error', err && err.message ? err.message : err);
    if (err && err.name === 'JsonWebTokenError') return res.status(403).send('invalid token');
    return res.status(500).send('proxy error');
  }
};

// Admin: validate segments for a video and optionally mirror to local storage
exports.validateVideo = async (req, res) => {
  try {
    const { videoId } = req.params;
    const { mirror } = req.body || {};
    const video = await Video.findById(videoId);
    if (!video) return res.status(404).json({ message: 'video not found' });
    const results = await validateVideoSegments(video, !!mirror);
    return res.json({ ok: true, results });
  } catch (err) {
    console.error('validateVideo error', err && err.message);
    return res.status(500).json({ message: err.message });
  }
};

// Admin: update video metadata (title, duration)
exports.updateVideo = async (req, res) => {
  try {
    const { videoId } = req.params;
    const { title, duration } = req.body || {};
    const update = {};
    if (typeof title !== 'undefined') update.title = title;
    if (typeof duration !== 'undefined') update.duration = Number(duration) || 0;
    const video = await Video.findByIdAndUpdate(videoId, update, { new: true });
    if (!video) return res.status(404).json({ message: 'video not found' });
    return res.json(video);
  } catch (err) {
    console.error('updateVideo error', err && err.message);
    return res.status(500).json({ message: err.message });
  }
};


// Helper to validate a single video's segments. Returns object mapping quality -> [{segment, ok, ...}]
// validateVideoSegments(video, mirror, allowFullCheck = true)
// - if allowFullCheck is false, only try the stored lastSegmentUrl once and throw on failure
// options: { signal: AbortSignal }
async function validateVideoSegments(video, mirror, allowFullCheck = true, options = {}) {
  const results = {};
  const MAX_SEGMENTS = parseInt(process.env.VIDEO_VALIDATE_MAX_SEGMENTS || '300', 10);
  const CONCURRENCY = parseInt(process.env.VIDEO_VALIDATE_CONCURRENCY || '6', 10);
  const AXIOS_TIMEOUT = parseInt(process.env.VIDEO_VALIDATE_TIMEOUT_MS || '5000', 10);

  const axios = require('axios');
  const https = require('https');
  const allowInsecure = String(process.env.VIDEO_ALLOW_INSECURE_UPSTREAM || '').toLowerCase() === 'true';
  const baseCfg = {};
  if (allowInsecure) baseCfg.httpsAgent = new https.Agent({ rejectUnauthorized: false });

  // helper: fetch a URL with a small retry/backoff strategy
  async function fetchWithRetries(method, url, cfg = {}, maxAttempts = 3) {
    let attempt = 0;
    let lastErr = null;
    const baseDelay = 200;
    for (; attempt < maxAttempts; attempt++) {
      try {
        if (method === 'head') return await axios.head(url, cfg);
        return await axios.get(url, cfg);
      } catch (err) {
        lastErr = err;
        // treat 404/410 as terminal for HEAD quick-checks (caller may decide)
        const status = err && err.response && err.response.status;
        if (status === 410 || status === 404) throw err;
        // for 429 (rate limit) and 5xx, back off longer
        const delay = baseDelay * Math.pow(2, attempt) + (status === 429 ? 800 : 0);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
    }
    throw lastErr;
  }

  for (const q of video.qualities) {
    results[q.quality] = [];
    // per-quality summary collector
    const qSummary = { totalChecked: 0, okCount: 0, failedCount: 0, failedSegments: [], mirrorErrors: [] };

    // Quick check: try the stored lastSegmentUrl (or url) once and short-circuit if it responds OK.
    const lastBase = q.lastSegmentUrl || q.url || '';
    if (lastBase) {
      try {
        const cfg = { ...baseCfg, timeout: AXIOS_TIMEOUT };
        if (options && options.signal) cfg.signal = options.signal;
        // prefer HEAD, but fall back to GET if HEAD is not allowed; use fetchWithRetries which handles transient errors
        let resp;
        try {
          resp = await fetchWithRetries('head', lastBase, cfg, 2);
        } catch (hErr) {
          // try GET as fallback
          resp = await fetchWithRetries('get', lastBase, { ...cfg, responseType: 'arraybuffer' }, 2);
        }
        const rec = { segment: 'last', ok: true, status: resp.status || 200, url: lastBase, note: 'lastSegment quick check' };
        results[q.quality].push(rec);
        qSummary.totalChecked += 1; qSummary.okCount += 1;
        if (mirror) {
          try {
            const r2cfg = { ...baseCfg, responseType: 'stream', timeout: AXIOS_TIMEOUT };
            if (options && options.signal) r2cfg.signal = options.signal;
            const r2 = await fetchWithRetries('get', lastBase, r2cfg, 2);
            const upload = await gridfs.uploadStreamFromStream(video._id.toString(), q.quality, 'last', r2.data, r2.headers && r2.headers['content-type'] ? r2.headers['content-type'] : 'application/octet-stream');
            results[q.quality][results[q.quality].length-1].mirrored = `gridfs://${upload.filename}`;
          } catch (e) {
              results[q.quality][results[q.quality].length-1].mirrored = null;
              results[q.quality][results[q.quality].length-1].mirrorError = { message: e && (e.message || String(e)), stack: e && e.stack, status: e && e.response && e.response.status };
              qSummary.mirrorErrors.push({ message: e && (e.message || String(e)), stack: e && e.stack, status: e && e.response && e.response.status });
          }
        }
        // short-circuit: consider this quality validated
        // attach summary and continue
        results[q.quality].summary = qSummary;
        continue;
      } catch (err) {
        // last-segment check failed
        // If upstream returned a permanent-not-found (410) or 404, treat as terminal
        const status = err && err.response && err.response.status;
        if (status === 410 || status === 404) {
          const e = new Error(`last-segment check returned ${status} for quality=${q.quality}`);
          e.original = err;
          e.terminal = true;
          throw e;
        }
        if (!allowFullCheck) {
          // caller asked not to perform full per-segment checks — propagate error so caller can retry/fail
          const e = new Error(`last-segment check failed for quality=${q.quality}: ${err && (err.message || String(err))}`);
          e.original = err;
          throw e;
        }
        // otherwise fall back to full per-segment check
      }
    }

    // fallback: check per-segment
    let segmentCount = (q.segmentCount && q.segmentCount > 1) ? q.segmentCount : estimateSegmentCountFromUrl(q.lastSegmentUrl || q.url || '');
    if (!segmentCount || segmentCount < 1) {
      const vidDuration = Number(video.duration) || 0;
      const defaultSegLen = Number(process.env.DEFAULT_SEGMENT_DURATION || 6);
      if (vidDuration > 0) segmentCount = Math.max(1, Math.ceil(vidDuration / Math.max(1, defaultSegLen)));
      else segmentCount = 1;
    }

    // enforce max limit to avoid runaway scans
    if (segmentCount > MAX_SEGMENTS) segmentCount = MAX_SEGMENTS;

    const segments = [];
    for (let i = 1; i <= segmentCount; i++) segments.push(i);

    // helper to build final URL for a given index
    function buildUrlForIndex(idx) {
      const parts = (q.lastSegmentUrl || q.url || '').split('/');
      const last = parts.pop();
      const matches = [...last.matchAll(/\d+/g)];
      let newLast = last;
      if (matches && matches.length > 0) {
        let best = matches[0];
        for (const mmm of matches) if (parseInt(mmm[0],10) > parseInt(best[0],10)) best = mmm;
        const digits = best[0];
        const idxPos = best.index;
        const padded = String(idx).padStart(digits.length, '0');
        newLast = last.slice(0, idxPos) + padded + last.slice(idxPos + digits.length);
      } else {
        const mm = last.match(/(\.[^.]+)$/);
        if (mm) newLast = last.replace(mm[1], `_${idx}${mm[1]}`);
        else newLast = `${last}_${idx}`;
      }
      parts.push(newLast);
      return { url: parts.join('/'), filename: newLast };
    }

    // process in batches with limited concurrency
    for (let start = 0; start < segments.length; start += CONCURRENCY) {
      const batch = segments.slice(start, start + CONCURRENCY);
      const promises = batch.map(async (i) => {
        const { url: finalUrl, filename: newLast } = buildUrlForIndex(i);
        try {
          const cfg = { ...baseCfg, timeout: AXIOS_TIMEOUT };
          if (options && options.signal) cfg.signal = options.signal;
          // prefer HEAD then GET with retries/backoff
          let resp;
          try {
            resp = await fetchWithRetries('head', finalUrl, cfg, 2);
          } catch (hErr) {
            resp = await fetchWithRetries('get', finalUrl, { ...cfg, responseType: 'arraybuffer' }, 2);
          }
          const rec = { segment: i, ok: true, status: resp.status || 200, url: finalUrl };
          if (mirror) {
            try {
              const r2cfg = { ...baseCfg, responseType: 'stream', timeout: AXIOS_TIMEOUT };
              if (options && options.signal) r2cfg.signal = options.signal;
              const r2 = await fetchWithRetries('get', finalUrl, r2cfg, 2);
              const upload = await gridfs.uploadStreamFromStream(video._id.toString(), q.quality, i, r2.data, r2.headers && r2.headers['content-type'] ? r2.headers['content-type'] : 'application/octet-stream');
              rec.mirrored = `gridfs://${upload.filename}`;
            } catch (e) {
              rec.mirrored = null;
              rec.mirrorError = { message: e && (e.message || String(e)), stack: e && e.stack, status: e && e.response && e.response.status };
              qSummary.mirrorErrors.push({ message: e && (e.message || String(e)), stack: e && e.stack, status: e && e.response && e.response.status });
            }
          }
          qSummary.totalChecked += 1; qSummary.okCount += 1;
          return rec;
        } catch (err) {
          const eStr = err && (err.stack || err.message || String(err));
          qSummary.totalChecked += 1; qSummary.failedCount += 1; qSummary.failedSegments.push(i);
          return { segment: i, ok: false, error: err && (err.message || String(err)), errorStack: eStr, url: finalUrl };
        }
      });

      const settled = await Promise.all(promises);
      results[q.quality].push(...settled);
    }
    // attach per-quality summary
    results[q.quality].summary = qSummary;
  }
  // compute overall meta
  const meta = { totalQualities: Object.keys(results).length, timestamp: new Date() };
  let totalChecked = 0; let totalFailed = 0; const qualities = {};
  for (const k of Object.keys(results)) {
    const s = results[k] && results[k].summary ? results[k].summary : { totalChecked: 0, failedCount: 0 };
    qualities[k] = s;
    totalChecked += s.totalChecked || 0;
    totalFailed += s.failedCount || 0;
  }
  meta.totalChecked = totalChecked; meta.totalFailed = totalFailed; meta.qualities = qualities;
  results._meta = meta;
  return results;
}

exports._validateVideoSegments = validateVideoSegments;

// Simple in-memory job manager for validation jobs
const validationJobs = new Map();

// Helper: check if any validation job is currently running
function hasRunningValidation() {
  for (const v of validationJobs.values()) {
    if (v && v.status === 'running') return true;
  }
  return false;
}

exports._hasRunningValidation = hasRunningValidation;

function createJobRecord() {
  return {
    id: String(Date.now()) + Math.random().toString(36).slice(2, 8),
    status: 'queued', // queued, running, finished, failed, stopped
    paused: false,
    startedAt: null,
    finishedAt: null,
    totalVideos: 0,
    processedVideos: 0,
    currentVideo: null,
    videos: [], // per-video results as they complete
    error: null,
  };
}

// Admin: start validate-all job (async). Returns job id immediately.
exports.startValidateAllVideos = async (req, res) => {
  try {
    const { mirror } = req.body || {};
    // prevent concurrent validate-all jobs
    if (hasRunningValidation()) {
      return res.status(409).json({ message: 'A validation job is already running' });
    }
    const job = createJobRecord();

    // Persist initial job doc
    const jobDoc = await ValidationJob.create({ ...job, startedAt: null });
    // keep in-memory reference for faster control (pause/resume)
    validationJobs.set(jobDoc.id, jobDoc);

    // Kick off background processing (do not await)
    (async () => {
      try {
        // refresh job from DB
        const inMemory = validationJobs.get(jobDoc.id) || {};
        inMemory.status = 'running';
        inMemory.startedAt = new Date();
        inMemory.paused = false;
        validationJobs.set(jobDoc.id, inMemory);
        await ValidationJob.findOneAndUpdate({ id: jobDoc.id }, { $set: { status: 'running', startedAt: inMemory.startedAt, paused: false } });

        const videos = await Video.find({}).sort({ createdAt: 1 });
        inMemory.totalVideos = videos.length;
        await ValidationJob.findOneAndUpdate({ id: jobDoc.id }, { $set: { totalVideos: inMemory.totalVideos } });

        console.log(`[validate-job ${jobDoc.id}] started - total videos: ${inMemory.totalVideos}`);
        const PER_VIDEO_TIMEOUT_MS = parseInt(process.env.VIDEO_PER_VIDEO_TIMEOUT_MS || '120000', 10);

        for (const v of videos) {
                // honor pause/stop requests
                while (true) {
                  const latest = validationJobs.get(jobDoc.id);
                  if (!latest) break; // job removed
                  if (latest.status === 'stopped') {
                          console.log(`[validate-job ${jobDoc.id}] stopped by admin`);
                          // mark finished as stopped
                          const finishedAt = new Date();
                          const finishedUpdate = { status: 'stopped', currentVideo: null, finishedAt };
                          validationJobs.set(jobDoc.id, { ...(validationJobs.get(jobDoc.id) || {}), ...finishedUpdate });
                          await ValidationJob.findOneAndUpdate({ id: jobDoc.id }, { $set: finishedUpdate });
                          try { await sendValidationWebhook(Object.assign({}, (validationJobs.get(jobDoc.id) || {}), finishedUpdate)); } catch (e) {}
                          return;
                  }
                  if (latest.paused) {
                    await new Promise((r) => setTimeout(r, 500));
                    continue;
                  }
                  break;
                }

          const latestJob = validationJobs.get(jobDoc.id) || {};
          latestJob.currentVideo = { videoId: v._id, title: v.title };
          validationJobs.set(jobDoc.id, latestJob);
          await ValidationJob.findOneAndUpdate({ id: jobDoc.id }, { $set: { currentVideo: latestJob.currentVideo } });

          // insert a placeholder result so frontends can show this video as 'in-progress'
          try {
            latestJob.videos = latestJob.videos || [];
            const placeholder = { videoId: v._id, lectureId: v.lectureId, title: v.title, ok: undefined, startedAt: new Date() };
            latestJob.videos.push(placeholder);
            latestJob.processedVideos = latestJob.videos.length;
            await ValidationJob.findOneAndUpdate({ id: jobDoc.id }, { $set: { videos: latestJob.videos, processedVideos: latestJob.processedVideos } });
            validationJobs.set(jobDoc.id, latestJob);
          } catch (e) {
            // non-fatal
          }

          // perform per-video validation with limited retries (2 attempts)
          const maxAttempts = 2;
          let attempt = 0;
          let ok = false;
          let lastErr = null;

          // perform attempts but enforce a per-video deadline to avoid runaway processing
          const startTs = Date.now();
          const deadline = startTs + PER_VIDEO_TIMEOUT_MS;
          while (attempt < maxAttempts) {
            if (Date.now() > deadline) {
              lastErr = lastErr || new Error('video-validation-timeout');
              console.error(`[validate-job ${jobDoc.id}] video ${v._id} timed out after ${PER_VIDEO_TIMEOUT_MS}ms`);
              break;
            }
            try {
              console.log(`[validate-job ${jobDoc.id}] video ${v._id} attempt ${attempt+1}`);
              const allowFull = (attempt === maxAttempts - 1);
              // create abort controller that will fire at the deadline to cancel axios requests
              let controller = null;
              let abortTimer = null;
              try {
                if (typeof AbortController !== 'undefined') {
                  controller = new AbortController();
                  const remaining = Math.max(1000, deadline - Date.now());
                  abortTimer = setTimeout(() => {
                    try { controller.abort(); } catch (e) {}
                  }, remaining);
                }
              } catch (e) {
                controller = null;
              }

              const perAttemptTimeout = Math.max(1000, deadline - Date.now());
              let results;
              try {
                results = await Promise.race([
                  validateVideoSegments(v, !!mirror, allowFull, { signal: controller ? controller.signal : undefined }),
                  new Promise((_, rej) => setTimeout(() => rej(new Error('validate-attempt-timeout')), perAttemptTimeout)),
                ]);
              } finally {
                if (abortTimer) clearTimeout(abortTimer);
              }
              const rec = { videoId: v._id, lectureId: v.lectureId, title: v.title, ok: true, results, processedAt: new Date() };
              // attach high-level summary into the job record for UI
              try {
                const meta = results && results._meta ? results._meta : null;
                const qualitiesSummary = {};
                if (results) {
                  for (const qq of Object.keys(results)) {
                    if (qq === '_meta') continue;
                    const arr = results[qq] || [];
                    qualitiesSummary[qq] = arr.summary || { totalChecked: arr.length, failedCount: (arr.filter && arr.filter(x=>!x.ok).length) || 0 };
                  }
                }
                rec.summary = { meta, qualities: qualitiesSummary };
              } catch (e) {}
              try {
                latestJob.videos = latestJob.videos || [];
                const idx = latestJob.videos.findIndex((it) => String(it.videoId) === String(v._id));
                if (idx >= 0) {
                  latestJob.videos[idx] = rec;
                } else {
                  latestJob.videos.push(rec);
                }
                latestJob.processedVideos = latestJob.videos.length;
                await ValidationJob.findOneAndUpdate({ id: jobDoc.id }, { $set: { videos: latestJob.videos, processedVideos: latestJob.processedVideos } });
                validationJobs.set(jobDoc.id, latestJob);
              } catch (e) {}
              console.log(`[validate-job ${jobDoc.id}] video ${v._id} OK on attempt ${attempt+1}`);
              ok = true;
              break;
            } catch (e) {
              lastErr = e;
              console.error(`[validate-job ${jobDoc.id}] video ${v._id} attempt ${attempt+1} failed:`, e && (e.stack || e.message || e));
              // if this error is terminal (e.g. 404/410 on last segment), stop retrying and move on
              if (e && e.terminal) {
                console.log(`[validate-job ${jobDoc.id}] video ${v._id} terminal error — skipping further attempts`);
                break;
              }
              attempt += 1;
              if (Date.now() > deadline) break;
              // small backoff before retrying
              await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
            }
          }

          if (!ok) {
            const rec = { videoId: v._id, lectureId: v.lectureId, title: v.title, ok: false, error: lastErr && (lastErr.message || String(lastErr)), processedAt: new Date() };
            try { rec.errorStack = lastErr && (lastErr.stack || lastErr.message || String(lastErr)); } catch (e) {}
            try {
              latestJob.videos = latestJob.videos || [];
              const idx = latestJob.videos.findIndex((it) => String(it.videoId) === String(v._id));
              if (idx >= 0) {
                latestJob.videos[idx] = rec;
              } else {
                latestJob.videos.push(rec);
              }
              latestJob.processedVideos = latestJob.videos.length;
              await ValidationJob.findOneAndUpdate({ id: jobDoc.id }, { $set: { videos: latestJob.videos, processedVideos: latestJob.processedVideos } });
              validationJobs.set(jobDoc.id, latestJob);
            } catch (e) {}
            console.error(`[validate-job ${jobDoc.id}] video ${v._id} FAILED after ${maxAttempts} attempts`);

            // Create a broadcast notification for admins so broken videos appear in notifications
            try {
              const lecture = await Lecture.findById(v.lectureId).select('title chapterId thumbnailUrl thumbnail').lean();
              let chapterTitle = null;
              if (lecture && lecture.chapterId) {
                const chap = await Chapter.findById(lecture.chapterId).select('title').lean();
                chapterTitle = chap && chap.title;
              }
              const notifTitle = `فيديو غير متاح: ${v.title}`;
              // avoid spamming duplicates: check for a similar notification in last 24 hours
              const dayAgo = new Date(Date.now() - 1000 * 60 * 60 * 24);
              const exists = await Notification.findOne({ lectureId: v.lectureId, title: notifTitle, createdAt: { $gt: dayAgo } });
              if (!exists) {
                await Notification.create({
                  title: notifTitle,
                  lectureId: v.lectureId,
                  videoId: v._id,
                  chapterId: lecture && lecture.chapterId,
                  thumbnailUrl: (lecture && (lecture.thumbnailUrl || lecture.thumbnail)) || undefined,
                  chapterTitle: chapterTitle || undefined,
                  // empty recipients => broadcast
                  recipients: [],
                  // this notification is for admins only
                  adminOnly: true,
                });
              }
            } catch (notifyErr) {
              console.warn('Failed to create notification for broken video', v._id, notifyErr && (notifyErr.message || notifyErr));
            }
          }

          // progress log
          console.log(`[validate-job ${jobDoc.id}] progress ${latestJob.processedVideos}/${latestJob.totalVideos}`);
        }

        const finishedAt = new Date();
        const finishedUpdate = { status: 'finished', currentVideo: null, finishedAt };
        validationJobs.set(jobDoc.id, { ...(validationJobs.get(jobDoc.id) || {}), ...finishedUpdate });
        await ValidationJob.findOneAndUpdate({ id: jobDoc.id }, { $set: finishedUpdate });
        try { await sendValidationWebhook(Object.assign({}, (validationJobs.get(jobDoc.id) || {}), finishedUpdate)); } catch (e) {}
        console.log(`[validate-job ${jobDoc.id}] finished - processed ${ (validationJobs.get(jobDoc.id) || {}).processedVideos || 0 }/${(validationJobs.get(jobDoc.id) || {}).totalVideos || 0}`);
      } catch (err) {
        const failedAt = new Date();
        const failureRecord = { ...(validationJobs.get(jobDoc.id) || {}), status: 'failed', error: err && (err.message || String(err)), finishedAt: failedAt };
        validationJobs.set(jobDoc.id, failureRecord);
        await ValidationJob.findOneAndUpdate({ id: jobDoc.id }, { $set: { status: 'failed', error: err && (err.message || String(err)), finishedAt: failedAt } });
        try { await sendValidationWebhook(failureRecord); } catch (e) {}
        console.error('startValidateAllVideos background error', err && (err.stack || err.message || err));
      }
    })();

    return res.json({ ok: true, jobId: jobDoc.id });
  } catch (err) {
    console.error('startValidateAllVideos error', err && err.message);
    return res.status(500).json({ message: err.message });
  }
};

// Admin: get validation job status
exports.getValidateJob = async (req, res) => {
  try {
    const { jobId } = req.params;
    // Prefer DB-backed job so refreshes always get persisted state
    const jobDoc = await ValidationJob.findOne({ id: jobId });
    if (!jobDoc) return res.status(404).json({ message: 'job not found' });
    // merge in-memory overrides (like paused) if present
    const inMemory = validationJobs.get(jobId) || {};
    const merged = Object.assign({}, jobDoc.toObject(), { paused: inMemory.paused || jobDoc.paused });
    return res.json({ ok: true, job: merged });
  } catch (err) {
    console.error('getValidateJob error', err && err.message);
    return res.status(500).json({ message: err.message });
  }
};

// Admin: get latest validation job (prefer running one)
exports.getLatestValidateJob = async (req, res) => {
  try {
    // try find a running job first
    let jobDoc = await ValidationJob.findOne({ status: 'running' }).sort({ startedAt: -1 });
    if (!jobDoc) {
      // fallback to most recent job
      jobDoc = await ValidationJob.findOne({}).sort({ startedAt: -1 });
    }
    if (!jobDoc) return res.json({ ok: true, job: null });
    // merge any in-memory overrides (like currentVideo, paused, or videos being updated)
    const inMemory = validationJobs.get(jobDoc.id) || {};
    const merged = Object.assign({}, jobDoc.toObject(), {
      paused: inMemory.paused || jobDoc.paused,
      status: inMemory.status || jobDoc.status,
      currentVideo: inMemory.currentVideo || jobDoc.currentVideo,
      videos: inMemory.videos || jobDoc.videos,
      processedVideos: inMemory.processedVideos || jobDoc.processedVideos,
    });
    return res.json({ ok: true, job: merged });
  } catch (err) {
    console.error('getLatestValidateJob error', err && err.message);
    return res.status(500).json({ message: err.message });
  }
};

// Admin: list all videos (basic fields) for admin UI
exports.getAllVideosAdmin = async (req, res) => {
  try {
    const vids = await Video.find({}).select('_id title lectureId createdAt').sort({ createdAt: -1 });
    return res.json({ ok: true, videos: vids });
  } catch (err) {
    console.error('getAllVideosAdmin error', err && err.message);
    return res.status(500).json({ message: err.message });
  }
};

// Admin: pause a running validation job
exports.pauseValidateJob = async (req, res) => {
  try {
    const { jobId } = req.params;
    const jobDoc = await ValidationJob.findOne({ 
      $or: [
        { id: jobId },
        { _id: jobId }
      ]
    });
    if (!jobDoc) return res.status(404).json({ message: 'job not found' });
    await ValidationJob.findOneAndUpdate(
      { _id: jobDoc._id },
      { $set: { paused: true } }
    );
    const mem = validationJobs.get(jobDoc.id || jobId) || {};
    mem.paused = true;
    validationJobs.set(jobDoc.id || jobId, mem);
    return res.json({ ok: true });
  } catch (err) {
    console.error('pauseValidateJob error', err && err.message);
    return res.status(500).json({ message: err.message });
  }
};

// Admin: resume a paused validation job
exports.resumeValidateJob = async (req, res) => {
  try {
    const { jobId } = req.params;
    const jobDoc = await ValidationJob.findOne({ 
      $or: [
        { id: jobId },
        { _id: jobId }
      ]
    });
    if (!jobDoc) return res.status(404).json({ message: 'job not found' });
    await ValidationJob.findOneAndUpdate(
      { _id: jobDoc._id },
      { $set: { paused: false } }
    );
    const mem = validationJobs.get(jobDoc.id || jobId) || {};
    mem.paused = false;
    validationJobs.set(jobDoc.id || jobId, mem);
    return res.json({ ok: true });
  } catch (err) {
    console.error('resumeValidateJob error', err && err.message);
    return res.status(500).json({ message: err.message });
  }
};

// Admin: stop a validation job (mark stopped and signal background worker)
exports.stopValidateJob = async (req, res) => {
  try {
    const { jobId } = req.params;
    const jobDoc = await ValidationJob.findOne({ 
      $or: [
        { id: jobId },
        { _id: jobId }
      ]
    });
    if (!jobDoc) return res.status(404).json({ message: 'job not found' });

    // Update DB status
    await ValidationJob.findOneAndUpdate(
      { _id: jobDoc._id },
      { $set: { status: 'stopped' } }
    );
    // update in-memory signal
    const mem = validationJobs.get(jobDoc.id || jobId) || {};
    mem.status = 'stopped';
    mem.paused = false;
    validationJobs.set(jobDoc.id || jobId, mem);
    return res.json({ ok: true });
  } catch (err) {
    console.error('stopValidateJob error', err && err.message);
    return res.status(500).json({ message: err.message });
  }
};

// Admin: list validation jobs (basic)
exports.listValidateJobs = async (req, res) => {
  try {
    const jobs = await ValidationJob.find({}).sort({ createdAt: -1 }).limit(100);
    // merge in-memory flags
    const out = jobs.map((j) => {
      const mem = validationJobs.get(j.id) || {};
      return Object.assign({}, j.toObject ? j.toObject() : j, { paused: mem.paused || j.paused, status: mem.status || j.status, currentVideo: mem.currentVideo || j.currentVideo, processedVideos: (typeof mem.processedVideos !== 'undefined') ? mem.processedVideos : j.processedVideos, totalVideos: (typeof mem.totalVideos !== 'undefined') ? mem.totalVideos : j.totalVideos });
    });
    return res.json({ ok: true, jobs: out });
  } catch (err) {
    console.error('listValidateJobs error', err && err.message);
    return res.status(500).json({ message: err.message });
  }
};

// Admin: revalidate a single video and append result to a job ("jump to failed")
exports.revalidateJobVideo = async (req, res) => {
  try {
    const { jobId, videoId } = req.params;
    const jobDoc = await ValidationJob.findOne({ id: jobId });
    if (!jobDoc) return res.status(404).json({ message: 'job not found' });
    const v = await Video.findById(videoId);
    if (!v) return res.status(404).json({ message: 'video not found' });
    try {
      const results = await validateVideoSegments(v, false, false);
      const rec = { videoId: v._id, lectureId: v.lectureId, title: v.title, ok: true, results, processedAt: new Date() };
      try {
        const meta = results && results._meta ? results._meta : null;
        const qualitiesSummary = {};
        if (results) {
          for (const qq of Object.keys(results)) {
            if (qq === '_meta') continue;
            const arr = results[qq] || [];
            qualitiesSummary[qq] = arr.summary || { totalChecked: arr.length, failedCount: (arr.filter && arr.filter(x=>!x.ok).length) || 0 };
          }
        }
        rec.summary = { meta, qualities: qualitiesSummary };
      } catch (e) {}
      jobDoc.videos.push(rec);
      jobDoc.processedVideos = jobDoc.videos.length;
      await jobDoc.save();
      // update in-memory
      const mem = validationJobs.get(jobId) || {};
      mem.videos = jobDoc.videos;
      mem.processedVideos = jobDoc.processedVideos;
      validationJobs.set(jobId, mem);
      return res.json({ ok: true, rec });
    } catch (err) {
      const rec = { videoId: v._id, lectureId: v.lectureId, title: v.title, ok: false, error: err && (err.message || String(err)), processedAt: new Date() };
      try { rec.errorStack = err && (err.stack || err.message || String(err)); } catch (e) {}
      jobDoc.videos.push(rec);
      jobDoc.processedVideos = jobDoc.videos.length;
      await jobDoc.save();
      const mem = validationJobs.get(jobId) || {};
      mem.videos = jobDoc.videos;
      mem.processedVideos = jobDoc.processedVideos;
      validationJobs.set(jobId, mem);
      return res.json({ ok: true, rec });
    }
  } catch (err) {
    console.error('revalidateJobVideo error', err && err.message);
    return res.status(500).json({ message: err.message });
  }
};

// Admin: delete a validation job
exports.deleteValidateJob = async (req, res) => {
  try {
    const { jobId } = req.params;
    const jobDoc = await ValidationJob.findOne({ 
      $or: [
        { id: jobId },
        { _id: jobId }
      ]
    });
    if (!jobDoc) return res.status(404).json({ message: 'job not found' });
    
    // Delete from memory cache
    validationJobs.delete(jobDoc.id || jobId);
    
    // Delete from database
    await ValidationJob.findByIdAndDelete(jobDoc._id);
    
    return res.json({ ok: true, message: 'Validation job deleted successfully' });
  } catch (err) {
    console.error('deleteValidateJob error', err && err.message);
    return res.status(500).json({ message: err.message });
  }
};

// Start a simple background scheduler that periodically triggers a validate-all job.
// It avoids starting a new job while one is running. Interval (minutes) can be configured
// via env `VIDEO_VALIDATE_INTERVAL_MINUTES` (default 60). This is safe to call multiple
// times; it will only install the scheduler once per process.
exports.startValidationScheduler = function startValidationScheduler() {
  try {
    if (global.__videoValidationSchedulerStarted) return;
    // Default to 12 hours (720 minutes) if not configured; can be overridden via env
    const minutes = parseInt(process.env.VIDEO_VALIDATE_INTERVAL_MINUTES || '720', 10) || 720;
    const ms = Math.max(1, minutes) * 60 * 1000;
    global.__videoValidationSchedulerStarted = true;

    // On boot, attempt to resume any running/queued job stored in DB before starting a fresh run.
    setTimeout(async () => {
      try {
        // prefer a job explicitly marked as 'running'
        let jobDoc = await ValidationJob.findOne({ status: 'running' }).sort({ startedAt: -1 });
        if (!jobDoc) {
          // fallback to a queued job (server crashed while queued)
          jobDoc = await ValidationJob.findOne({ status: 'queued' }).sort({ createdAt: -1 });
        }
        if (jobDoc) {
          try {
            // hydrate in-memory and resume processing
            validationJobs.set(jobDoc.id, jobDoc.toObject ? jobDoc.toObject() : jobDoc);
            console.log('[validate-scheduler] resuming validation job', jobDoc.id);
            await resumeValidationJob(jobDoc.id);
            return;
          } catch (e) {
            console.error('Failed to resume validation job', jobDoc.id, e && (e.message || e));
          }
        }
        // otherwise start a fresh run
        if (!hasRunningValidation()) {
          await exports.startValidateAllVideos({ body: { mirror: false } }, { json: () => {}, status: () => ({ json: () => {} }) });
        }
      } catch (e) {
        console.error('Initial validation run failed', e && (e.message || e));
      }
    }, 5000);

    // periodic
    setInterval(async () => {
      try {
        if (hasRunningValidation()) return;
        await exports.startValidateAllVideos({ body: { mirror: false } }, { json: () => {}, status: () => ({ json: () => {} }) });
      } catch (e) {
        console.error('Periodic validation run failed', e && (e.message || e));
      }
    }, ms);
  } catch (err) {
    console.error('Failed to start validation scheduler', err && (err.message || err));
  }
};

// Resume processing of an existing validation job stored in DB (called on startup)
async function resumeValidationJob(jobId) {
  try {
    const jobDoc = await ValidationJob.findOne({ id: jobId });
    if (!jobDoc) throw new Error('job not found');
    // mark running
    const inMemory = validationJobs.get(jobId) || {};
    inMemory.status = 'running';
    inMemory.startedAt = inMemory.startedAt || jobDoc.startedAt || new Date();
    inMemory.paused = false;
    // ensure videos array exists
    inMemory.videos = jobDoc.videos || [];
    inMemory.processedVideos = (inMemory.videos && inMemory.videos.length) || 0;
    validationJobs.set(jobId, inMemory);
    await ValidationJob.findOneAndUpdate({ id: jobId }, { $set: { status: 'running', startedAt: inMemory.startedAt, paused: false } });

    // build processed set to skip already-validated videos
    // NOTE: ignore placeholders where `ok` is still undefined so partially-written placeholders
    // don't cause a video to be skipped on resume.
    const processedSet = new Set((inMemory.videos || []).filter((p) => typeof p.ok !== 'undefined').map((p) => String(p.videoId)));
    const videos = await Video.find({}).sort({ createdAt: 1 });

    console.log(`[validate-job ${jobId}] resuming - total videos: ${videos.length}, already processed: ${processedSet.size}`);

    const PER_VIDEO_TIMEOUT_MS = parseInt(process.env.VIDEO_PER_VIDEO_TIMEOUT_MS || '120000', 10);

    for (const v of videos) {
      // skip already processed
      if (processedSet.has(String(v._id))) continue;

      // honor pause/stop
      while (true) {
        const latest = validationJobs.get(jobId);
        if (!latest) break;
        if (latest.status === 'stopped') {
            console.log(`[validate-job ${jobId}] stopped by admin during resume`);
            const finishedAt = new Date();
            const finishedUpdate = { status: 'stopped', currentVideo: null, finishedAt };
            validationJobs.set(jobId, { ...(validationJobs.get(jobId) || {}), ...finishedUpdate });
            await ValidationJob.findOneAndUpdate({ id: jobId }, { $set: finishedUpdate });
            try { await sendValidationWebhook(Object.assign({}, (validationJobs.get(jobId) || {}), finishedUpdate)); } catch (e) {}
            return;
        }
        if (latest.paused) {
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        break;
      }

      const latestJob = validationJobs.get(jobId) || {};
      latestJob.currentVideo = { videoId: v._id, title: v.title };
      validationJobs.set(jobId, latestJob);
      await ValidationJob.findOneAndUpdate({ id: jobId }, { $set: { currentVideo: latestJob.currentVideo } });

      // placeholder
      try {
        latestJob.videos = latestJob.videos || [];
        const placeholder = { videoId: v._id, lectureId: v.lectureId, title: v.title, ok: undefined, startedAt: new Date() };
        latestJob.videos.push(placeholder);
        latestJob.processedVideos = latestJob.videos.length;
        await ValidationJob.findOneAndUpdate({ id: jobId }, { $set: { videos: latestJob.videos, processedVideos: latestJob.processedVideos } });
        validationJobs.set(jobId, latestJob);
      } catch (e) {}

      // perform validation attempts (reuse same logic as startValidateAllVideos)
      const maxAttempts = 2;
      let attempt = 0;
      let ok = false;
      let lastErr = null;
      const startTs = Date.now();
      const deadline = startTs + PER_VIDEO_TIMEOUT_MS;

      while (attempt < maxAttempts) {
        if (Date.now() > deadline) { lastErr = lastErr || new Error('video-validation-timeout'); break; }
        try {
          const allowFull = (attempt === maxAttempts - 1);
          let controller = null; let abortTimer = null;
          try {
            if (typeof AbortController !== 'undefined') {
              controller = new AbortController();
              const remaining = Math.max(1000, deadline - Date.now());
              abortTimer = setTimeout(() => { try { controller.abort(); } catch (e) {} }, remaining);
            }
          } catch (e) { controller = null; }

          const perAttemptTimeout = Math.max(1000, deadline - Date.now());
          let results;
          try {
            results = await Promise.race([
              validateVideoSegments(v, false, allowFull, { signal: controller ? controller.signal : undefined }),
              new Promise((_, rej) => setTimeout(() => rej(new Error('validate-attempt-timeout')), perAttemptTimeout)),
            ]);
          } finally { if (abortTimer) clearTimeout(abortTimer); }

          const rec = { videoId: v._id, lectureId: v.lectureId, title: v.title, ok: true, results, processedAt: new Date() };
          try {
            // attach per-video summary for resumed jobs as well
            try {
              const meta = results && results._meta ? results._meta : null;
              const qualitiesSummary = {};
              if (results) {
                for (const qq of Object.keys(results)) {
                  if (qq === '_meta') continue;
                  const arr = results[qq] || [];
                  qualitiesSummary[qq] = arr.summary || { totalChecked: arr.length, failedCount: (arr.filter && arr.filter(x=>!x.ok).length) || 0 };
                }
              }
              rec.summary = { meta, qualities: qualitiesSummary };
            } catch (e) {}
            latestJob.videos = latestJob.videos || [];
            const idx = latestJob.videos.findIndex((it) => String(it.videoId) === String(v._id));
            if (idx >= 0) latestJob.videos[idx] = rec; else latestJob.videos.push(rec);
            latestJob.processedVideos = latestJob.videos.length;
            await ValidationJob.findOneAndUpdate({ id: jobId }, { $set: { videos: latestJob.videos, processedVideos: latestJob.processedVideos } });
            validationJobs.set(jobId, latestJob);
          } catch (e) {}
          ok = true; break;
        } catch (e) {
          lastErr = e;
          if (e && e.terminal) break;
          attempt += 1;
          if (Date.now() > deadline) break;
          await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
        }
      }

      if (!ok) {
        const rec = { videoId: v._id, lectureId: v.lectureId, title: v.title, ok: false, error: lastErr && (lastErr.message || String(lastErr)), processedAt: new Date() };
          try {
            // include stack or diagnostic from lastErr if available
            rec.errorStack = lastErr && (lastErr.stack || lastErr.message || String(lastErr));
          } catch (e) {}
        try {
          latestJob.videos = latestJob.videos || [];
          const idx = latestJob.videos.findIndex((it) => String(it.videoId) === String(v._id));
          if (idx >= 0) latestJob.videos[idx] = rec; else latestJob.videos.push(rec);
          latestJob.processedVideos = latestJob.videos.length;
          await ValidationJob.findOneAndUpdate({ id: jobId }, { $set: { videos: latestJob.videos, processedVideos: latestJob.processedVideos } });
          validationJobs.set(jobId, latestJob);
        } catch (e) {}

        // create notification for admin (best-effort)
        try {
          const lecture = await Lecture.findById(v.lectureId).select('title chapterId thumbnailUrl thumbnail').lean();
          let chapterTitle = null;
          if (lecture && lecture.chapterId) {
            const chap = await Chapter.findById(lecture.chapterId).select('title').lean();
            chapterTitle = chap && chap.title;
          }
          const notifTitle = `فيديو غير متاح: ${v.title}`;
          const dayAgo = new Date(Date.now() - 1000 * 60 * 60 * 24);
          const exists = await Notification.findOne({ lectureId: v.lectureId, title: notifTitle, createdAt: { $gt: dayAgo } });
          if (!exists) {
            await Notification.create({ title: notifTitle, lectureId: v.lectureId, videoId: v._id, chapterId: lecture && lecture.chapterId, thumbnailUrl: (lecture && (lecture.thumbnailUrl || lecture.thumbnail)) || undefined, chapterTitle: chapterTitle || undefined, recipients: [], adminOnly: true });
          }
        } catch (notifyErr) { console.warn('Failed to create notification for broken video', v._id, notifyErr && (notifyErr.message || notifyErr)); }
      }

    }

    const finishedAt = new Date();
    const finishedUpdate = { status: 'finished', currentVideo: null, finishedAt };
    validationJobs.set(jobId, { ...(validationJobs.get(jobId) || {}), ...finishedUpdate });
    await ValidationJob.findOneAndUpdate({ id: jobId }, { $set: finishedUpdate });
    try { await sendValidationWebhook(Object.assign({}, (validationJobs.get(jobId) || {}), finishedUpdate)); } catch (e) {}
    console.log(`[validate-job ${jobId}] resumed run finished - processed ${ (validationJobs.get(jobId) || {}).processedVideos || 0 }/${(validationJobs.get(jobId) || {}).totalVideos || 0}`);
  } catch (err) {
    const failedAt = new Date();
    validationJobs.set(jobId, { ...(validationJobs.get(jobId) || {}), status: 'failed', error: err && err.message, finishedAt: failedAt });
    await ValidationJob.findOneAndUpdate({ id: jobId }, { $set: { status: 'failed', error: err && err.message, finishedAt: failedAt } });
    console.error('resumeValidationJob error', err && (err.stack || err.message || err));
  }
}

// Admin: list users who viewed a specific video
exports.getVideoViewers = async (req, res) => {
  try {
    const { videoId } = req.params;
    const VideoView = require('../models/VideoView');
    const views = await VideoView.find({ videoId }).sort({ createdAt: -1 }).populate('userId', 'name phone');
    return res.json(views);
  } catch (err) {
    console.error('getVideoViewers error', err);
    return res.status(500).json({ message: err.message });
  }
};

// Admin: delete a video and unlink from lecture
exports.deleteVideo = async (req, res) => {
  try {
    const { videoId } = req.params;
    if (!videoId) return res.status(400).json({ message: 'videoId required' });
    const VideoModel = require('../models/Video');
    const LectureModel = require('../models/Lecture');

    const video = await VideoModel.findById(videoId);
    if (!video) return res.status(404).json({ message: 'video not found' });

    // remove video doc
    await VideoModel.findByIdAndDelete(videoId);

    // remove reference from lecture.videos array if present
    try {
      await LectureModel.findByIdAndUpdate(video.lectureId, { $pull: { videos: { id: videoId } } });
    } catch (e) {
      // non-fatal
      console.warn('Failed to unlink video from lecture', e && e.message);
    }

    // best-effort cleanup: remove VideoView entries
    try {
      const VideoView = require('../models/VideoView');
      await VideoView.deleteMany({ videoId });
    } catch (e) {
      // ignore
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('deleteVideo error', err && err.message ? err.message : err);
    return res.status(500).json({ message: err.message });
  }
};

// Admin: update video metadata (title, duration, qualities)
exports.updateVideo = async (req, res) => {
  try {
    const { videoId } = req.params;
    const { title, duration, qualities } = req.body;
    const VideoModel = require('../models/Video');

    if (!videoId) return res.status(400).json({ message: 'videoId required' });

    let parsedQualities = undefined;
    if (typeof qualities !== 'undefined') {
      try {
        parsedQualities = typeof qualities === 'string' ? JSON.parse(qualities) : qualities;
      } catch (err) {
        return res.status(400).json({ message: 'Invalid qualities JSON' });
      }
      // normalize qualities shape
      parsedQualities = parsedQualities.map((q) => ({
        quality: String(q.quality || q.q || ''),
        lastSegmentUrl: q.lastSegmentUrl || q.last_segment_url || q.url || '',
        segmentCount: q.segmentCount || q.segment_count || undefined,
      }));
    }

    const update = {};
    if (typeof title !== 'undefined') update.title = title;
    if (typeof duration !== 'undefined') update.duration = Number(duration) || 0;
    if (typeof parsedQualities !== 'undefined') update.qualities = parsedQualities;

    const updated = await VideoModel.findByIdAndUpdate(videoId, update, { new: true });
    if (!updated) return res.status(404).json({ message: 'video not found' });

    // After admin updates a video, attempt a quick validation in background.
    (async () => {
      try {
        // run a focused validation (allow full check) to see if the video is now available
        const results = await validateVideoSegments(updated, false, true);
        // results: { quality: [{ segment, ok, ... }] }
        let ok = false;
        try {
          for (const q of Object.keys(results || {})) {
            const arr = results[q] || [];
            if (arr.length > 0 && arr.every((s) => s.ok)) {
              ok = true; break;
            }
          }
        } catch (e) {}

        if (ok) {
          try {
            // remove stale 'video unavailable' notifications for this video (avoid spam)
            await Notification.deleteMany({ videoId: updated._id, title: { $regex: '^فيديو غير متاح:' } });
          } catch (e) {}
          try {
            // If there are no more 'video unavailable' admin notifications for the whole lecture,
            // create a broadcast notification for regular users that the lecture is now working.
            const lecture = await Lecture.findById(updated.lectureId).select('title chapterId thumbnailUrl thumbnail').lean();
            let chapterTitle = null;
            if (lecture && lecture.chapterId) {
              const chap = await Chapter.findById(lecture.chapterId).select('title').lean();
              chapterTitle = chap && chap.title;
            }
            // Check for any remaining admin 'video unavailable' notifications for this lecture
            const remaining = await Notification.findOne({ lectureId: updated.lectureId, title: { $regex: '^فيديو غير متاح:' } });
            if (!remaining) {
              const notifTitle = lecture && lecture.title ? `المحاضرة أصبحت تعمل الآن: ${lecture.title}` : `المحاضرة أصبحت تعمل الآن`;
              await Notification.create({
                title: notifTitle,
                lectureId: updated.lectureId,
                chapterId: lecture && lecture.chapterId,
                thumbnailUrl: (lecture && (lecture.thumbnailUrl || lecture.thumbnail)) || undefined,
                chapterTitle: chapterTitle || undefined,
                // empty recipients => broadcast; userOnly:true ensures admins do not receive it
                recipients: [],
                userOnly: true,
              });
            }
          } catch (e) {}
        }
      } catch (e) {
        // ignore background validation errors
      }
    })();
    return res.json(updated);
  } catch (err) {
    console.error('updateVideo error', err);
    return res.status(500).json({ message: err.message });
  }
};

// Record a view for a specific video (user must be authenticated and have subscription)
exports.recordVideoView = async (req, res) => {
  try {
    const VideoView = require('../models/VideoView');
    const VideoModel = require('../models/Video');
    const userId = req.user && req.user._id;
    const { videoId } = req.params;
    if (!userId) return res.status(401).json({ message: 'Unauthenticated' });

    try {
      await VideoView.create({ userId, videoId });
    } catch (err) {
      // ignore duplicate key (user already viewed)
      if (err.code !== 11000) console.warn('VideoView create warning', err.message || err);
    }

    // best-effort increment viewCount on Video
    try {
      await VideoModel.findByIdAndUpdate(videoId, { $inc: { viewCount: 1 } });
    } catch (e) {
      // ignore
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('recordVideoView error', err);
    return res.status(500).json({ message: err.message });
  }
};

// Stream a downloadable file by concatenating segments sequentially.
// This lets the browser manage the download independently so refreshing
// the original page doesn't cancel it. Requires auth + subscription.
exports.download = async (req, res) => {
  try {
    const { videoId } = req.params;
    const quality = req.query.quality || req.query.q;

    // check permission: only admin or users allowed to download
    const user = req.user;
    if (!user) return res.status(401).json({ message: 'Unauthenticated' });
    if (!user.isAdmin && !user.canDownloadVideos) return res.status(403).json({ message: 'Download not allowed' });

    const video = await Video.findById(videoId);
    if (!video) return res.status(404).json({ message: 'video not found' });
    const q = video.qualities.find((x) => String(x.quality) === String(quality)) || video.qualities[0];
    if (!q) return res.status(404).json({ message: 'quality not found' });

    // Determine segment count
    const segmentCount = (q.segmentCount && q.segmentCount > 1) ? q.segmentCount : estimateSegmentCountFromUrl(q.lastSegmentUrl || q.url || '');

    // Prepare response headers for download
    const rawTitle = (video && video.title) ? String(video.title) : 'video';
    const asciiTitle = rawTitle.replace(/[^a-z0-9\-_. ]/gi, '_');
    const qualityLabel = q.quality ? `${q.quality}p` : 'video';
    const ext = '.ts';
    const asciiFilename = `${asciiTitle}_${qualityLabel}${ext}`;
    const utfFilename = `${rawTitle}_${qualityLabel}${ext}`;
    res.setHeader('Content-Type', 'video/MP2T');
    // Provide both ASCII fallback and RFC5987 UTF-8 filename*
    try {
      res.setHeader('Content-Disposition', `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(utfFilename)}`);
    } catch (e) {
      res.setHeader('Content-Disposition', `attachment; filename="${asciiFilename}"`);
    }

    // Build final segment URLs first so we can optionally compute total size
    const finalUrls = [];
    for (let i = 1; i <= Math.max(1, segmentCount); i++) {
      const parts = (q.lastSegmentUrl || q.url || '').split('/');
      const last = parts.pop();
      const matches = [...last.matchAll(/\d+/g)];
      let newLast = last;
      if (matches && matches.length > 0) {
        let best = matches[0];
        for (const mmm of matches) if (parseInt(mmm[0],10) > parseInt(best[0],10)) best = mmm;
        const digits = best[0];
        const idx = best.index;
        const padded = String(i).padStart(digits.length, '0');
        newLast = last.slice(0, idx) + padded + last.slice(idx + digits.length);
      } else {
        const mm = last.match(/(\.[^.]+)$/);
        if (mm) newLast = last.replace(mm[1], `_${i}${mm[1]}`);
        else newLast = `${last}_${i}`;
      }
      parts.push(newLast);
      finalUrls.push(parts.join('/'));
    }

    // Skip doing HEAD requests for each segment to compute total size.
    // Performing those HEAD requests can introduce a noticeable "preparing" delay
    // before any bytes reach the client. We stream segments immediately so the
    // browser starts the download right away (Transfer-Encoding: chunked).

    // Stream segments sequentially
    const allowInsecure = String(process.env.VIDEO_ALLOW_INSECURE_UPSTREAM || '').toLowerCase() === 'true';
    const https = require('https');
    const axiosConfigStream = { responseType: 'stream' };
    if (allowInsecure) axiosConfigStream.httpsAgent = new https.Agent({ rejectUnauthorized: false });
    for (const finalUrl of finalUrls) {
      if (res.headersSent && res.writableEnded) break;
      try {
        const upstreamRes = await require('axios').get(finalUrl, axiosConfigStream);
        // pipe upstream stream to client and wait until it finishes
        await new Promise((resolve, reject) => {
          upstreamRes.data.on('data', (chunk) => {
            try { res.write(chunk); } catch (e) { /* client likely closed */ }
          });
          upstreamRes.data.on('end', resolve);
          upstreamRes.data.on('error', reject);
          // if client disconnects, stop streaming
          req.on('close', () => {
            try { if (upstreamRes.data && upstreamRes.data.destroy) upstreamRes.data.destroy(); } catch (e) {}
            resolve();
          });
        });
      } catch (err) {
        console.error('[download] failed fetching segment', finalUrl, err && err.message);
        break;
      }
    }

    try { res.end(); } catch (e) {}
    return;
  } catch (err) {
    console.error('download error', err && err.message);
    try { if (!res.headersSent) res.status(500).json({ message: err.message }); } catch (e) {}
  }
};
