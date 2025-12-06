const express = require('express');
const router = express.Router();
const uploadController = require('../../controllers/upload.controller');
const authMiddleware = require('../../middleware/auth');
const uploadMiddleware = require('../../middleware/upload');
const { body } = require('express-validator');

// 파일 업로드
router.post(
  '/',
  authMiddleware.verifyToken,
  uploadMiddleware.single('file'),
  [
    body('title').notEmpty().withMessage('Title is required'),
    body('description').optional(),
    body('pricePerMinute')
      .optional()
      .isFloat({ min: 0.01, max: 100 })
      .withMessage('Price must be between 0.01 and 100 TLT'),
    body('isFree').optional().isBoolean()
  ],
  uploadController.uploadFile
);

// 업로드 상태 확인
router.get(
  '/status/:fileId',
  authMiddleware.verifyToken,
  uploadController.getUploadStatus
);

// 사용자 파일 목록
router.get(
  '/my-files',
  authMiddleware.verifyToken,
  uploadController.getUserFiles
);

// 파일 정보 수정
router.patch(
  '/:fileId',
  authMiddleware.verifyToken,
  uploadController.updateFile
);

// 파일 삭제
router.delete(
  '/:fileId',
  authMiddleware.verifyToken,
  uploadController.deleteFile
);

module.exports = router;
