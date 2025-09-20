// controllers/talkingPointController.js
const { HttpError, NotFoundError, BadRequestError } = require('../errors/HttpError');
const { generateTalkingPoints, getTalkingPointTemplates } = require('../services/talkingPointService');

/**
 * POST /talking‑points
 * req.body: { appointmentId, templateId? }
 */
exports.generateTalkingPoints = async (req, res) => {
  const authSub = req.auth?.sub;
  const appointmentId = parseInt(req.body.appointmentId, 10);
  const templateId = req.body.templateId ? parseInt(req.body.templateId, 10) : null;

  /* ── basic validation ── */
  if (!authSub) {
    return res.status(401).json({ error: 'Unauthenticated' });
  }
  if (Number.isNaN(appointmentId)) {
    return res.status(400).json({ error: 'appointmentId must be a number' });
  }
  if (templateId && Number.isNaN(templateId)) {
    return res.status(400).json({ error: 'templateId must be a number' });
  }

  try {
    const talkingPoints = await generateTalkingPoints({ appointmentId, authSub, templateId });
    return res.status(200).json({ talkingPoints });
  } catch (error) {
    console.error('Error generating talking points:', error);

    if (error instanceof HttpError) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * GET /talking-points/templates
 * Returns all available talking point templates for the user
 */
exports.getTalkingPointTemplates = async (req, res) => {
  const authSub = req.auth?.sub;

  if (!authSub) {
    return res.status(401).json({ error: 'Unauthenticated' });
  }

  try {
    const templates = await getTalkingPointTemplates({ authSub });
    return res.status(200).json({ templates });
  } catch (error) {
    console.error('Error fetching talking point templates:', error);

    if (error instanceof HttpError) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};
