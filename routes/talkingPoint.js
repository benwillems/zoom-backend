// routes/talkingPointRoutes.js
const express = require('express');
const router = express.Router();
const talkingPointController = require('../controllers/talkingPointController');

// POST /api/talking-points - Generate talking points (optionally with specific template)
router.post('/talkingPoints/generate', talkingPointController.generateTalkingPoints);

// GET /api/talking-points/templates - Get all available talking point templates
router.get('/talkingPoints/templates', talkingPointController.getTalkingPointTemplates);

module.exports = router;
