const express = require('express');
const router = express.Router();
const videoController = require('../controllers/videoController');

// Route to stream video
router.get('/stream/:fileId', videoController.streamVideo);

module.exports = router;
