const express = require('express');
const materialController = require('../controllers/materialController');
const { adminMiddleware } = require('../middleware/auth');
const { authMiddleware, checkSubscription } = require('../middleware/auth');
const upload = require('../middleware/uploadMiddleware');

const router = express.Router();

// Admin only routes
router.post('/', adminMiddleware, upload.single('thumbnail'), materialController.createMaterial);
router.put('/:id', adminMiddleware, upload.single('thumbnail'), materialController.updateMaterial);
router.delete('/:id', adminMiddleware, materialController.deleteMaterial);

// Public routes
router.get('/', materialController.getAllMaterials);
router.get('/:id/students-count', materialController.getStudentsCount);
router.post('/:id/enroll', authMiddleware, checkSubscription, materialController.enrollToMaterial);
router.get('/:id', authMiddleware, checkSubscription, materialController.getMaterialById);

module.exports = router;
