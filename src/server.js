require('dotenv').config();
require('express-async-errors');

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

// Routes
const authRoutes = require('./routes/authRoutes');
const materialRoutes = require('./routes/materialRoutes');
const instructorRoutes = require('./routes/instructorRoutes');
const chapterRoutes = require('./routes/chapterRoutes');
const lectureRoutes = require('./routes/lectureRoutes');
const pdfRoutes = require('./routes/pdfRoutes');
const videoRoutes = require('./routes/videoRoutes');
const uploadsRoutes = require('./routes/uploadsRoutes');
const treeRoutes = require('./routes/treeRoutes');
const adminRoutes = require('./routes/adminRoutes');
const notificationsRoutes = require('./routes/notificationsRoutes');
const searchRoutes = require('./routes/searchRoutes');

// Middleware
const { authMiddleware, optionalAuth, adminMiddleware } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 5000;
const FRONTEND_URL = process.env.FRONTEND_URL;
// =====================
// CORS (STRICT)
// =====================
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests from frontend and ngrok URL
      if (!origin || origin === FRONTEND_URL) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true, // Allow credentials (cookies, authorization headers, etc.)
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'user-code',
      'device-id',
      'device_id',
      'session-token',
      'session_token',
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
  })
);

// Expose certain headers to the browser (so frontend can read Content-Length / Content-Disposition)
app.use((req, res, next) => {
  res.header('Access-Control-Expose-Headers', 'Content-Length, Content-Disposition');
  next();
});

// =====================
// Body parsers
// =====================

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// =====================
// MongoDB Connection
// =====================


// Resilient MongoDB connection with retry on startup and helpful options
const mongooseOptions = {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS) || 10000,
  socketTimeoutMS: Number(process.env.MONGO_SOCKET_TIMEOUT_MS) || 45000,
  connectTimeoutMS: Number(process.env.MONGO_CONNECT_TIMEOUT_MS) || 10000,
  maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE) || 20,
  family: 4,
};

function startServer() {
  app.listen(PORT, () => {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`Server running on http://localhost:${PORT}`);
    }
    // Start the Video Status scheduler (lightweight in-process probe loop)
    try {
      const { startScheduler } = require('./services/videoStatusScheduler');
      startScheduler();
    } catch (e) {
      console.warn('Failed to start video status scheduler', e && e.message);
    }
  });
}

function connectWithRetry(retries = 0) {
  return mongoose.connect(process.env.MONGODB_URI, mongooseOptions)
    .then(() => {
      console.log('MongoDB connected');
      startServer();
    })
    .catch((err) => {
      console.error('MongoDB connection failed', err && (err.message || err));
      const wait = Math.min(30000, 1000 * Math.pow(2, retries));
      console.log(`Retrying MongoDB connection in ${wait}ms`);
      setTimeout(() => connectWithRetry(retries + 1), wait);
    });
}

// Attach connection event listeners for visibility
try {
  const mongoose = require('mongoose');
  mongoose.connection.on('connected', () => console.log('mongoose: connected'));
  mongoose.connection.on('reconnected', () => console.log('mongoose: reconnected'));
  mongoose.connection.on('disconnected', () => console.warn('mongoose: disconnected'));
  mongoose.connection.on('close', () => console.warn('mongoose: connection closed'));
  mongoose.connection.on('error', (e) => console.error('mongoose: connection error', e && (e.message || e)));
} catch (e) {}

// Start initial connect (with retries)
connectWithRetry();
// Note: server.listen is started from connectWithRetry once connected
    

// =====================
// Public Routes
// =====================

app.use('/auth', authRoutes);
app.use('/api/tree', treeRoutes);

// Global search (optional auth)
app.use('/api/search', optionalAuth, searchRoutes);

// =====================
// Protected Routes
// =====================
app.use('/api/materials', authMiddleware, materialRoutes);
app.use('/api/instructors', authMiddleware, instructorRoutes);
app.use('/api/chapters', authMiddleware, chapterRoutes);
app.use('/api/lectures', authMiddleware, lectureRoutes);
app.use('/api/uploads', authMiddleware, uploadsRoutes);
// Allow public access to GET notifications (broadcasts). Protect write endpoints separately.
app.use('/api/notifications', optionalAuth, notificationsRoutes);

// Server-Sent Events endpoint for notifications (public + authenticated users)
try {
  const { addClient, removeClient } = require('./utils/notificationBus');
  app.get('/api/notifications/stream', optionalAuth, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    // Allow the client to reconnect automatically
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders && res.flushHeaders();
    const meta = { userId: req.user?._id, isAdmin: !!req.user?.isAdmin };
    addClient(res, meta);
    req.on('close', () => {
      removeClient(res);
    });
  });
} catch (e) {
  console.warn('notifications stream not available', e && e.message);
}

// Graceful shutdown: ensure SSE clients are closed
try {
  const { closeAll } = require('./utils/notificationBus');
  const shutdown = async () => {
    try { closeAll(); } catch (e) {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('beforeExit', shutdown);
} catch (e) {}

// Some routes manage auth internally
app.use('/api/pdfs', pdfRoutes);
app.use('/api/videos', videoRoutes);

// Admin
app.use('/api/admin', adminRoutes);

// =====================
// Health Check (optional)
// =====================
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK' });
});

// =====================
// Error Handler
// =====================
app.use((err, req, res, next) => {
  if (process.env.NODE_ENV !== 'production') {
    console.error(err);
  }
  res.status(500).json({
    message: 'Internal server error',
  });
});

// =====================
// 404 Handler
// =====================
app.use((req, res) => {
  res.status(404).json({ message: 'Not found' });
});

// Note: server starts after successful MongoDB connection above