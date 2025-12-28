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
const { authMiddleware, optionalAuth } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 5000;
const FRONTEND_URL = process.env.FRONTEND_URL;
const NGROK_URL = 'https://shifty-gymnastically-wonda.ngrok-free.dev'; // رابط ngrok الحالي


// =====================
// CORS (STRICT)
// =====================
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests from frontend and ngrok URL
      if (!origin || origin === FRONTEND_URL || origin === NGROK_URL) {
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


mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    if (process.env.NODE_ENV !== 'production') {
      console.log('MongoDB connected');
    }

    // Start server only after DB connected to avoid buffering timeouts
    app.listen(PORT, () => {
      if (process.env.NODE_ENV !== 'production') {
        console.log(`Server running on http://localhost:${PORT}`);
      }
      try {
        // start periodic video validation scheduler (optional)
        const videoController = require('./controllers/videoController');
        if (videoController && typeof videoController.startValidationScheduler === 'function') {
          videoController.startValidationScheduler();
          if (process.env.NODE_ENV !== 'production') console.log('Video validation scheduler started');
        }
      } catch (e) {
        console.error('Failed to start video validation scheduler', e && (e.message || e));
      }
    });
  })
  .catch((err) => {
    console.error('MongoDB connection failed', err && err.message);
    process.exit(1);
  });


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