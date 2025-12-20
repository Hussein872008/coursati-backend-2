const express = require('express');
const router = express.Router();
const { globalSearch } = require('../controllers/searchController');

// GET /api/search?q=term
router.get('/', globalSearch);

module.exports = router;
