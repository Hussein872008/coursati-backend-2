const Video = require('../models/Video');
const Lecture = require('../models/Lecture');
const Chapter = require('../models/Chapter');
const Notification = require('../models/Notification');
const axios = require('axios');
const gridfs = require('../utils/gridfs');
// Segments are served directly (no token signing)

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

// Admin: list videos for admin dashboard with basic pagination
exports.getAllVideosAdmin = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(200, parseInt(req.query.limit || '50', 10));
    const skip = (page - 1) * limit;
    const filter = {};
    // optional lectureId filter
    if (req.query.lectureId) filter.lectureId = req.query.lectureId;

    const [videos, total] = await Promise.all([
      Video.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Video.countDocuments(filter),
    ]);

    return res.json({ total, page, limit, videos });
  } catch (err) {
    console.error('getAllVideosAdmin error', err);
    return res.status(500).json({ message: err.message });
  }
};

// Public availability endpoint removed.

// Segment signing removed. Segments are served directly via playlist URLs.

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
      // Direct segment URL (no signing)
      const segUrl = `/api/videos/${videoId}/segments/${quality}/${i}`;
      const dur = segmentDurations[i - 1] || 1;
      lines.push(`#EXTINF:${dur},`);
      lines.push(segUrl);
    }

    lines.push('#EXT-X-ENDLIST');

    const body = lines.join('\n');
    // cache briefly
    setPlaylistCache(cacheKey, body, 20);
    // expose video duration and playlist total for debugging (DB duration and playlist total)
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
    // Accept direct requests for segments and proxy upstream.

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
    // Allow disabling upstream TLS certificate checks via env VIDEO_ALLOW_INSECURE_UPSTREAM=true
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
    return res.status(500).send('proxy error');
  }
};

// (updateVideo implemented later with qualities support)


// Validation functionality removed.

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

// All recompute/manual-status endpoints removed.

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

    // After an edit to a video's metadata/qualities we should re-check the lecture
    // in background; if all videos become working, `checkLectureVideos` will
    // create/send recovery notifications (existing logic).
    try {
      const { checkLectureVideos } = require('../services/videoStatusService');
      // fire-and-forget but log result for troubleshooting
      (async () => {
        try {
          const resCheck = await checkLectureVideos(updated.lectureId);
          console.info('Post-update lecture recheck', updated.lectureId, JSON.stringify({ ok: resCheck && resCheck.ok, createdNotifications: resCheck && resCheck.createdNotifications ? resCheck.createdNotifications.length : 0 }));
        } catch (e) {
          console.warn('post-update checkLectureVideos failed', e && (e.message || e));
        }
      })();
    } catch (e) {
      console.warn('failed to trigger post-update lecture check', e && (e.message || e));
    }

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
