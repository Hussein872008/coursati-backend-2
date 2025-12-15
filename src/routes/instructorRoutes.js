const express = require('express');
const instructorController = require('../controllers/instructorController');
const { adminMiddleware } = require('../middleware/auth');
const upload = require('../middleware/uploadMiddleware');

const router = express.Router();

// Admin only routes
router.post('/', adminMiddleware, upload.single('thumbnail'), instructorController.createInstructor);
router.put('/:id', adminMiddleware, upload.single('thumbnail'), instructorController.updateInstructor);
router.delete('/:id', adminMiddleware, instructorController.deleteInstructor);

// Public routes
router.get('/material/:materialId', instructorController.getInstructorsByMaterial);
router.get('/:id', instructorController.getInstructorById);

module.exports = router;
