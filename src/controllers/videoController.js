const Video = require('../models/Video');
const Lecture = require('../models/Lecture');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const gridfs = require('../utils/gridfs');

const signSecret = process.env.VIDEO_SIGN_SECRET || process.env.JWT_SECRET;

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
    const token = jwt.sign({ videoId, quality, segmentNumber }, signSecret, { expiresIn: '2m' });
    return res.json({ token, expiresIn: 120 });
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

    for (let i = 1; i <= segmentCount; i++) {
      // shorter-lived tokens for playlist (2 minutes)
      const token = jwt.sign({ videoId, quality, segmentNumber: i }, signSecret, { expiresIn: '2m' });
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
      payload = jwt.verify(token, signSecret);
    } catch (err) {
      // token verify failed
      return res.status(403).send('invalid token');
    }
    if (!payload || payload.videoId !== videoId || payload.quality !== quality || Number(payload.segmentNumber) !== Number(segmentNumber)) {
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
    console.error('[proxySegment] all attempts failed for', finalUrl, 'lastErr:', lastErr && lastErr.message);
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

    const results = {};
    const fs = require('fs');
    const path = require('path');
    for (const q of video.qualities) {
      const segmentCount = (q.segmentCount && q.segmentCount > 1) ? q.segmentCount : estimateSegmentCountFromUrl(q.lastSegmentUrl || q.url || '');
      results[q.quality] = [];
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
            // Mirror into GridFS (store with predictable filename)
            try {
              const r2 = await axios.get(finalUrl, { ...(cfg || {}), responseType: 'stream' });
              const upload = await gridfs.uploadStreamFromStream(videoId, q.quality, i, r2.data, r2.headers['content-type'] || 'application/octet-stream');
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

    return res.json({ ok: true, results });
  } catch (err) {
    console.error('validateVideo error', err && err.message);
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
