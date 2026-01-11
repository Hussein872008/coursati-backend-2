const { spawnSync, execFileSync } = require('child_process');

function isFfprobeAvailable() {
  try {
    const res = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return res && res.status === 0;
  } catch (e) {
    return false;
  }
}

function probeFile(filePath) {
  try {
    const out = execFileSync(
      'ffprobe',
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
    );
    return JSON.parse(out);
  } catch (e) {
    const err = new Error('ffprobe failed: ' + (e && e.message));
    err.cause = e;
    throw err;
  }
}

module.exports = { isFfprobeAvailable, probeFile };
const { spawnSync, execFileSync } = require('child_process');

function isFfprobeAvailable() {
  try {
    const res = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return res && res.status === 0;
  } catch (e) {
    return false;
  }
}

function probeFile(filePath) {
  try {
    const out = execFileSync(
      'ffprobe',
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
    );
    return JSON.parse(out);
  } catch (e) {
    const err = new Error('ffprobe failed: ' + (e && e.message));
    err.cause = e;
    throw err;
  }
}

module.exports = { isFfprobeAvailable, probeFile };
