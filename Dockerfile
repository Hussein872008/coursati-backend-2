FROM node:22-alpine

# Install ffmpeg (provides ffprobe) and common build tools
RUN apk add --no-cache ffmpeg ca-certificates

WORKDIR /app

# Copy package manifests first for caching
COPY package.json package-lock.json ./

# Install production dependencies only (CI/build will run full install where needed)
RUN npm ci --production

# Copy application files
COPY . .

EXPOSE 5000

CMD ["node", "src/server.js"]
