const playService = require('../services/play.service');
const { validationResult } = require('express-validator');

exports.startPlayback = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { tlfId, fileId } = req.params;
    const userId = req.user.id;
    const userAddress = req.user.address;

    const playbackSession = await playService.startPlayback({
      tlfId,
      fileId,
      userId,
      userAddress,
      device: req.headers['user-agent'],
      ipAddress: req.ip
    });

    res.json({
      success: true,
      sessionId: playbackSession._id,
      playbackUrl: playbackSession.playbackUrl,
      priceInfo: playbackSession.priceInfo
    });

  } catch (error) {
    res.status(400).json({ 
      error: 'Playback failed to start', 
      details: error.message 
    });
  }
};

exports.updatePlayback = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { position, status } = req.body;
    const userId = req.user.id;

    const updated = await playService.updatePlayback(sessionId, userId, {
      position,
      status
    });

    res.json({
      success: true,
      updated,
      message: 'Playback updated'
    });

  } catch (error) {
    res.status(400).json({ 
      error: 'Failed to update playback', 
      details: error.message 
    });
  }
};

exports.finishPlayback = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = req.user.id;

    const result = await playService.finishPlayback(sessionId, userId);

    res.json({
      success: true,
      message: 'Playback finished',
      payment: result.payment,
      pointsEarned: result.pointsEarned
    });

  } catch (error) {
    res.status(400).json({ 
      error: 'Failed to finish playback', 
      details: error.message 
    });
  }
};

exports.getPlaybackHistory = async (req, res) => {
  try {
    const userId = req.user.id;
    const { page = 1, limit = 20, fileId } = req.query;

    const history = await playService.getUserPlaybackHistory(userId, {
      page: parseInt(page),
      limit: parseInt(limit),
      fileId
    });

    res.json({
      success: true,
      data: history.items,
      pagination: history.pagination
    });

  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to get playback history' 
    });
  }
};
