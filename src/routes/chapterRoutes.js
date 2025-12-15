const express = require('express');
const chapterController = require('../controllers/chapterController');
const { adminMiddleware } = require('../middleware/auth');
const upload = require('../middleware/uploadMiddleware');

const router = express.Router();

// Admin only routes
router.post('/', adminMiddleware, upload.single('thumbnail'), chapterController.createChapter);
router.put('/:id', adminMiddleware, upload.single('thumbnail'), chapterController.updateChapter);
router.delete('/:id', adminMiddleware, chapterController.deleteChapter);

// Public routes
router.get('/instructor/:instructorId', chapterController.getChaptersByInstructor);
router.get('/:id', chapterController.getChapterById);

module.exports = router;
