const express = require('express');
const router = express.Router();
const walletController = require('../../controllers/wallet.controller');
const authMiddleware = require('../../middleware/auth');
const { body } = require('express-validator');

// 지갑 연결
router.post(
  '/connect',
  [
    body('walletAddress').notEmpty().withMessage('Wallet address is required'),
    body('signature').notEmpty().withMessage('Signature is required'),
    body('message').notEmpty().withMessage('Message is required')
  ],
  walletController.connectWallet
);

// 지갑 정보 조회
router.get(
  '/info',
  authMiddleware.verifyToken,
  walletController.getWalletInfo
);

// 포인트 이력 조회
router.get(
  '/points/history',
  authMiddleware.verifyToken,
  walletController.getPointHistory
);

// 정산 이력 조회
router.get(
  '/settlements/history',
  authMiddleware.verifyToken,
  walletController.getSettlementHistory
);

// 출금 요청
router.post(
  '/withdraw',
  authMiddleware.verifyToken,
  [
    body('amount').isFloat({ min: 1.0 }).withMessage('Minimum withdrawal is 1.0 TLT')
  ],
  walletController.requestWithdrawal
);

// 데일리 체크인
router.post(
  '/checkin',
  authMiddleware.verifyToken,
  walletController.dailyCheckin
);

// 리워드 요약
router.get(
  '/rewards/summary',
  authMiddleware.verifyToken,
  walletController.getRewardSummary
);

module.exports = router;
