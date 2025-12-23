const Video = require('../models/Video');
const Lecture = require('../models/Lecture');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const gridfs = require('../utils/gridfs');
const ValidationJob = require('../models/ValidationJob');

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

    // Prefer stored segmentCount if > 1, otherwise try to estimate from lastSegmentUrl
    const segmentCount = (q.segmentCount && q.segmentCount > 1) ? q.segmentCount : estimateSegmentCountFromUrl(q.lastSegmentUrl || q.last_segment_url || q.url || '');
    const segDuration = Math.max(1, Math.round((video.duration || 0) / Math.max(1, segmentCount)));

    // Build m3u8
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${segDuration}`, '#EXT-X-MEDIA-SEQUENCE:1'];

    // Decide per-segment token TTL. Ensure it's at least long enough to cover playlist playback plus a safety margin.
    const configuredTtl = process.env.VIDEO_SEGMENT_TOKEN_TTL || '2m';
    const configuredSeconds = parseTtlToSeconds(configuredTtl);
    const playlistSeconds = Math.max(1, segDuration * segmentCount);
    const segTtlSeconds = Math.max(configuredSeconds, playlistSeconds + 30);
    for (let i = 1; i <= segmentCount; i++) {
      // sign tokens valid for segTtlSeconds
      const token = jwt.sign({ videoId, quality, segmentNumber: i }, signSecret, { expiresIn: segTtlSeconds });
      const segUrl = `/api/videos/${videoId}/segments/${quality}/${i}?token=${encodeURIComponent(token)}`;
      lines.push(`#EXTINF:${segDuration},`);
      lines.push(segUrl);
    }

    lines.push('#EXT-X-ENDLIST');

    const body = lines.join('\n');
    // cache briefly
    setPlaylistCache(cacheKey, body, 20);
    res.setHeader('content-type', 'application/vnd.apple.mpegurl');
    return res.send(body);
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

// Helper to validate a single video's segments. Returns object mapping quality -> [{segment, ok, ...}]
// validateVideoSegments(video, mirror, allowFullCheck = true)
// - if allowFullCheck is false, only try the stored lastSegmentUrl once and throw on failure
async function validateVideoSegments(video, mirror, allowFullCheck = true) {
  const results = {};
  for (const q of video.qualities) {
    results[q.quality] = [];
    // Quick check: try the stored lastSegmentUrl (or url) once and short-circuit if it responds OK.
    const lastBase = q.lastSegmentUrl || q.url || '';
    if (lastBase) {
      try {
        const axios = require('axios');
        const allowInsecure = String(process.env.VIDEO_ALLOW_INSECURE_UPSTREAM || '').toLowerCase() === 'true';
        const https = require('https');
        const cfg = {};
        if (allowInsecure) cfg.httpsAgent = new https.Agent({ rejectUnauthorized: false });
        // HEAD preferred; if not allowed try GET
        const resp = await axios.head(lastBase, cfg).catch(async (e) => {
          return axios.get(lastBase, { ...cfg, responseType: 'arraybuffer' }).then(r => r).catch((err) => { throw err; });
        });
        // success — treat the quality as OK based on last-segment URL
        results[q.quality].push({ segment: 'last', ok: true, status: resp.status || 200, url: lastBase });
        if (mirror) {
          try {
            const r2 = await axios.get(lastBase, { ...(cfg || {}), responseType: 'stream' });
            const upload = await gridfs.uploadStreamFromStream(video._id.toString(), q.quality, 'last', r2.data, r2.headers['content-type'] || 'application/octet-stream');
            results[q.quality][results[q.quality].length-1].mirrored = `gridfs://${upload.filename}`;
          } catch (e) {
            results[q.quality][results[q.quality].length-1].mirrored = null;
            results[q.quality][results[q.quality].length-1].mirrorError = e && e.message;
          }
        }
        // short-circuit: consider this quality validated
        continue;
      } catch (err) {
        // last-segment check failed
        if (!allowFullCheck) {
          // caller asked not to perform full per-segment checks — propagate error so caller can retry/fail
          throw err;
        }
        // otherwise fall back to full per-segment check
      }
    }

    // fallback: check per-segment (original behavior)
    const segmentCount = (q.segmentCount && q.segmentCount > 1) ? q.segmentCount : estimateSegmentCountFromUrl(q.lastSegmentUrl || q.url || '');
    for (let i = 1; i <= segmentCount; i++) {
      // build final upstream URL same as proxy logic
      const parts = (q.lastSegmentUrl || q.url).split('/');
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
      const finalUrl = parts.join('/');

      try {
        const axios = require('axios');
        const allowInsecure = String(process.env.VIDEO_ALLOW_INSECURE_UPSTREAM || '').toLowerCase() === 'true';
        const https = require('https');
        const cfg = {};
        if (allowInsecure) cfg.httpsAgent = new https.Agent({ rejectUnauthorized: false });
        const resp = await axios.head(finalUrl, cfg).catch(async (e) => {
          // try GET if HEAD not allowed
          return axios.get(finalUrl, { ...cfg, responseType: 'arraybuffer' }).then(r=>r).catch((err)=>{ throw err; });
        });
        results[q.quality].push({ segment: i, ok: true, status: resp.status || 200, url: finalUrl });

        
        if (mirror) {
          try {
            const r2 = await axios.get(finalUrl, { ...(cfg || {}), responseType: 'stream' });
            const upload = await gridfs.uploadStreamFromStream(video._id.toString(), q.quality, i, r2.data, r2.headers['content-type'] || 'application/octet-stream');
            results[q.quality][results[q.quality].length-1].mirrored = `gridfs://${upload.filename}`;
          } catch (e) {
            results[q.quality][results[q.quality].length-1].mirrored = null;
            results[q.quality][results[q.quality].length-1].mirrorError = e && e.message;
          }
        }
      } catch (err) {
        results[q.quality].push({ segment: i, ok: false, error: err && err.message, url: finalUrl });
      }
    }
  }
  return results;
}

exports._validateVideoSegments = validateVideoSegments;

// Simple in-memory job manager for validation jobs
const validationJobs = new Map();

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
        for (const v of videos) {
          // honor pause requests
          while (true) {
            const latest = validationJobs.get(jobDoc.id);
            if (!latest) break; // job removed
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

          // perform per-video validation with limited retries (2 attempts)
          const maxAttempts = 2;
          let attempt = 0;
          let ok = false;
          let lastErr = null;
          for (; attempt < maxAttempts; attempt++) {
            try {
              console.log(`[validate-job ${jobDoc.id}] video ${v._id} attempt ${attempt+1}`);
              // Only perform a fast check (last-segment) during job attempts — avoid full per-segment scans
              const results = await validateVideoSegments(v, !!mirror, false);
              const rec = { videoId: v._id, lectureId: v.lectureId, title: v.title, ok: true, results, processedAt: new Date() };
              latestJob.videos = latestJob.videos || [];
              latestJob.videos.push(rec);
              latestJob.processedVideos = latestJob.videos.length;
              await ValidationJob.findOneAndUpdate({ id: jobDoc.id }, { $set: { videos: latestJob.videos, processedVideos: latestJob.processedVideos } });
              console.log(`[validate-job ${jobDoc.id}] video ${v._id} OK on attempt ${attempt+1}`);
              ok = true;
              break;
            } catch (e) {
              lastErr = e;
              console.error(`[validate-job ${jobDoc.id}] video ${v._id} attempt ${attempt+1} failed:`, e && (e.stack || e.message || e));
              // small backoff before retrying
              await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
            }
          }

          if (!ok) {
            const rec = { videoId: v._id, lectureId: v.lectureId, title: v.title, ok: false, error: lastErr && (lastErr.message || String(lastErr)), processedAt: new Date() };
            latestJob.videos.push(rec);
            latestJob.processedVideos = latestJob.videos.length;
            await ValidationJob.findOneAndUpdate({ id: jobDoc.id }, { $set: { videos: latestJob.videos, processedVideos: latestJob.processedVideos } });
            console.error(`[validate-job ${jobDoc.id}] video ${v._id} FAILED after ${maxAttempts} attempts`);
          }

          // progress log
          console.log(`[validate-job ${jobDoc.id}] progress ${latestJob.processedVideos}/${latestJob.totalVideos}`);
        }

        const finishedAt = new Date();
        const finishedUpdate = { status: 'finished', currentVideo: null, finishedAt };
        validationJobs.set(jobDoc.id, { ...(validationJobs.get(jobDoc.id) || {}), ...finishedUpdate });
        await ValidationJob.findOneAndUpdate({ id: jobDoc.id }, { $set: finishedUpdate });
        console.log(`[validate-job ${jobDoc.id}] finished - processed ${ (validationJobs.get(jobDoc.id) || {}).processedVideos || 0 }/${(validationJobs.get(jobDoc.id) || {}).totalVideos || 0}`);
      } catch (err) {
        const failedAt = new Date();
        validationJobs.set(jobDoc.id, { ...(validationJobs.get(jobDoc.id) || {}), status: 'failed', error: err && err.message, finishedAt: failedAt });
        await ValidationJob.findOneAndUpdate({ id: jobDoc.id }, { $set: { status: 'failed', error: err && err.message, finishedAt: failedAt } });
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
    const jobDoc = await ValidationJob.findOne({ id: jobId });
    if (!jobDoc) return res.status(404).json({ message: 'job not found' });
    await ValidationJob.findOneAndUpdate({ id: jobId }, { $set: { paused: true } });
    const mem = validationJobs.get(jobId) || {};
    mem.paused = true;
    validationJobs.set(jobId, mem);
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
    const jobDoc = await ValidationJob.findOne({ id: jobId });
    if (!jobDoc) return res.status(404).json({ message: 'job not found' });
    await ValidationJob.findOneAndUpdate({ id: jobId }, { $set: { paused: false } });
    const mem = validationJobs.get(jobId) || {};
    mem.paused = false;
    validationJobs.set(jobId, mem);
    return res.json({ ok: true });
  } catch (err) {
    console.error('resumeValidateJob error', err && err.message);
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

    // Try to compute total length by doing HEAD requests for each segment (may fail)
    let totalBytes = 0;
    let canComputeTotal = true;
    const allowInsecure = String(process.env.VIDEO_ALLOW_INSECURE_UPSTREAM || '').toLowerCase() === 'true';
    const https = require('https');
    const axiosConfigBase = {};
    if (allowInsecure) axiosConfigBase.httpsAgent = new https.Agent({ rejectUnauthorized: false });
    for (const u of finalUrls) {
      try {
        const hres = await require('axios').head(u, axiosConfigBase);
        const cl = hres.headers && (hres.headers['content-length'] || hres.headers['content-length'.toLowerCase()]);
        const n = cl ? parseInt(cl, 10) : NaN;
        if (isNaN(n)) { canComputeTotal = false; break; }
        totalBytes += n;
      } catch (e) {
        canComputeTotal = false;
        break;
      }
    }

    if (canComputeTotal && totalBytes > 0) {
      try { res.setHeader('Content-Length', String(totalBytes)); } catch (e) { }
    }

    // Stream segments sequentially
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
