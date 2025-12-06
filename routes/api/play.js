const express = require('express');
const router = express.Router();
const playController = require('../../controllers/play.controller');
const authMiddleware = require('../../middleware/auth');
const { body, param } = require('express-validator');

// 재생 시작
router.post(
  '/start/:fileId',
  authMiddleware.verifyToken,
  [
    param('fileId').notEmpty().withMessage('File ID is required'),
    body('tlfId').optional()
  ],
  playController.startPlayback
);

// 재생 상태 업데이트
router.put(
  '/:sessionId',
  authMiddleware.verifyToken,
  [
    param('sessionId').notEmpty().withMessage('Session ID is required'),
    body('position').isNumeric().withMessage('Position must be a number'),
    body('status').optional().isIn(['playing', 'paused', 'finished'])
  ],
  playController.updatePlayback
);

// 재생 종료
router.post(
  '/finish/:sessionId',
  authMiddleware.verifyToken,
  [
    param('sessionId').notEmpty().withMessage('Session ID is required')
  ],
  playController.finishPlayback
);

// 재생 이력 조회
router.get(
  '/history',
  authMiddleware.verifyToken,
  playController.getPlaybackHistory
);

// 활성 세션 조회
router.get(
  '/active',
  authMiddleware.verifyToken,
  playController.getActiveSessions
);

module.exports = router;
