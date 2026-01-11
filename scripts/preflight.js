const path = require('path');
const { isFfprobeAvailable } = require(path.join(__dirname, '..', 'src', 'utils', 'systemFFprobe'));

function run() {
  const ok = isFfprobeAvailable();
  if (!ok) {
    console.error('preflight: ffprobe not available on PATH');
    process.exit(2);
  }
  console.log('preflight: ffprobe available');
}

if (require.main === module) run();

module.exports = { run };
