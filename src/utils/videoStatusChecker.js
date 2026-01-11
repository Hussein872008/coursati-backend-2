const axios = require('axios');

// Lightweight safe checker for a single URL. Performs a HEAD then a GET fallback
// with conservative timeouts and a small number of retries.
async function probeUrl(url, opts = {}) {
  const timeout = opts.timeout || 5000;
  const maxAttempts = Math.max(1, opts.retries || 2);
  const allowInsecure = String(process.env.VIDEO_ALLOW_INSECURE_UPSTREAM || '').toLowerCase() === 'true';
  const https = require('https');
  const axiosConfig = { timeout, validateStatus: null };
  if (allowInsecure) axiosConfig.httpsAgent = new https.Agent({ rejectUnauthorized: false });

  let lastErr = null;
    // exponential backoff with jitter
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      // Prefer HEAD to avoid downloading content, but some servers don't support HEAD.
      const headRes = await axios.head(url, axiosConfig).catch(() => null);
      if (headRes && headRes.status && headRes.status < 400) {
        return { ok: true, statusCode: headRes.status, method: 'HEAD' };
      }

      // Fallback to a small GET request with range header to minimize data transfer
      const getCfg = Object.assign({}, axiosConfig, { headers: { Range: 'bytes=0-1023' }, responseType: 'stream' });
      const getRes = await axios.get(url, getCfg).catch((e) => { lastErr = e; return null; });
      if (getRes && getRes.status && getRes.status < 400) {
        // consume a small amount then destroy stream to avoid full download
        try { if (getRes.data && typeof getRes.data.destroy === 'function') getRes.data.destroy(); } catch (e) {}
        return { ok: true, statusCode: getRes.status, method: 'GET' };
      }

      // treat 403/401/404/timeouts as failure indications
      if (headRes && headRes.status) {
        return { ok: false, statusCode: headRes.status };
      }
    } catch (err) {
      lastErr = err;
    }
      // backoff before retry with jitter
      const base = 250 * Math.pow(2, attempt); // exponential
      const jitter = Math.floor(Math.random() * 200);
      const delay = Math.min(10000, base + jitter);
      await new Promise((r) => setTimeout(r, delay));
  }

  return { ok: false, statusCode: (lastErr && lastErr.response && lastErr.response.status) || null, error: lastErr && (lastErr.message || String(lastErr)) };
}

module.exports = { probeUrl };
