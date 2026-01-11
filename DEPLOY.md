ffprobe (system) requirement
----------------------------

This project no longer depends on the `ffprobe-static` npm package.
Runtime and build now require `ffprobe` to be available on the PATH (provided by the `ffmpeg` package).

Alpine (Railpack) / CI notes:

- Install ffmpeg in Alpine images:

  apk add --no-cache ffmpeg

- In Dockerfiles based on Alpine add the above line before running the app.
- In CI workflows, ensure the runner installs `ffmpeg` (Alpine) or the appropriate package for the OS.

Behavior:

- On production startup the server will exit with a clear error if `ffprobe` is not found.
- In non-production the server logs a warning to allow local dev without ffprobe.
