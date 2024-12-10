const express = require('express');
const router = express.Router();
const imageController = require('../controllers/imageController');

router.post('/convert-image', imageController.convertImage);

module.exports = router;
