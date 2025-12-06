const express = require('express');
const router = express.Router();
const adminController = require('../../controllers/admin.controller');
const authMiddleware = require('../../middleware/auth');
const { body, param, query } = require('express-validator');

// 모든 어드민 라우트는 관리자 권한 필요
router.use(authMiddleware.verifyToken, authMiddleware.verifyAdmin);

// 대시보드 통계
router.get('/dashboard', adminController.getDashboardStats);

// 사용자 관리
router.get(
  '/users',
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('search').optional().isString(),
    query('role').optional().isIn(['user', 'creator', 'admin']),
    query('sortBy').optional().isIn(['createdAt', 'username', 'totalEarned']),
    query('sortOrder').optional().isIn(['asc', 'desc'])
  ],
  adminController.getUserList
);

router.patch(
  '/users/:userId',
  [
    param('userId').notEmpty().withMessage('User ID is required'),
    body('username').optional().isString(),
    body('email').optional().isEmail(),
    body('role').optional().isIn(['user', 'creator', 'admin']),
    body('isBanned').optional().isBoolean(),
    body('isVerified').optional().isBoolean(),
    body('points').optional().isInt()
  ],
  adminController.updateUser
);

// 콘텐츠 관리
router.get(
  '/files',
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('status').optional().isIn(['processing', 'ready', 'published', 'hidden', 'blocked']),
    query('type').optional().isIn(['video', 'audio', 'image', 'document']),
    query('creatorId').optional().isMongoId(),
    query('sortBy').optional().isIn(['createdAt', 'viewCount', 'totalEarned']),
    query('sortOrder').optional().isIn(['asc', 'desc'])
  ],
  adminController.getFileList
);

router.patch(
  '/files/:fileId',
  [
    param('fileId').notEmpty().withMessage('File ID is required'),
    body('status').optional().isIn(['processing', 'ready', 'published', 'hidden', 'blocked']),
    body('pricePerMinute').optional().isFloat({ min: 0.01, max: 100 }),
    body('title').optional().isString(),
    body('description').optional().isString(),
    body('tags').optional().isArray(),
    body('category').optional().isString()
  ],
  adminController.updateFile
);

// 포인트 관리
router.post(
  '/points/award',
  [
    body('userId').notEmpty().withMessage('User ID is required'),
    body('points').isInt({ min: 1 }).withMessage('Points must be positive integer'),
    body('reason').optional().isString()
  ],
  adminController.awardPoints
);

// 시스템 관리
router.get('/logs', adminController.getSystemLogs);
router.post('/cleanup-sessions', adminController.cleanupStaleSessions);
router.get('/settings', adminController.getPlatformSettings);

module.exports = router;
