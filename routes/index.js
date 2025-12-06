const express = require('express');
const router = express.Router();

// API 라우트 임포트
const uploadRoutes = require('./api/upload');
const playRoutes = require('./api/play');
const walletRoutes = require('./api/wallet');
const adminRoutes = require('./api/admin');
const tlfRoutes = require('./api/tlf');

// 라우트 설정
router.use('/upload', uploadRoutes);
router.use('/play', playRoutes);
router.use('/wallet', walletRoutes);
router.use('/admin', adminRoutes);
router.use('/tlf', tlfRoutes);

module.exports = router;
