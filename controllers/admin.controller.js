const User = require('../models/User');
const File = require('../models/File');
const Play = require('../models/Play');
const PointLedger = require('../models/PointLedger');
const uploadService = require('../services/upload.service');
const playService = require('../services/play.service');
const pointEngine = require('../services/point-engine');
const { validationResult } = require('express-validator');

exports.getDashboardStats = async (req, res) => {
  try {
    const [
      userCount,
      fileCount,
      totalPlays,
      totalEarnings,
      recentUsers,
      recentFiles,
      storageUsage
    ] = await Promise.all([
      User.countDocuments(),
      File.countDocuments(),
      Play.countDocuments({ isPaid: true }),
      File.aggregate([
        { $group: { _id: null, total: { $sum: "$totalEarned" } } }
      ]),
      User.find().sort({ createdAt: -1 }).limit(5),
      File.find().sort({ createdAt: -1 }).limit(5).populate('creatorId', 'username'),
      // storageUsage는 실제 구현 필요
    ]);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [
      todayUsers,
      todayUploads,
      todayPlays,
      todayEarnings
    ] = await Promise.all([
      User.countDocuments({ createdAt: { $gte: today } }),
      File.countDocuments({ createdAt: { $gte: today } }),
      Play.countDocuments({ createdAt: { $gte: today } }),
      Play.aggregate([
        { $match: { isPaid: true, createdAt: { $gte: today } } },
        { $group: { _id: null, total: { $sum: "$amountPaid" } } }
      ])
    ]);

    res.json({
      success: true,
      stats: {
        overview: {
          totalUsers: userCount,
          totalFiles: fileCount,
          totalPlays: totalPlays,
          totalEarnings: totalEarnings[0]?.total || 0
        },
        today: {
          newUsers: todayUsers,
          newUploads: todayUploads,
          newPlays: todayPlays,
          earnings: todayEarnings[0]?.total || 0
        },
        recent: {
          users: recentUsers.map(u => ({
            id: u._id,
            username: u.username,
            wallet: u.walletAddress,
            joined: u.createdAt
          })),
          files: recentFiles.map(f => ({
            id: f._id,
            title: f.title,
            creator: f.creatorId?.username || 'Unknown',
            type: f.fileType,
            status: f.status
          }))
        }
      }
    });

  } catch (error) {
    res.status(500).json({
      error: 'Failed to get dashboard stats',
      details: error.message
    });
  }
};

exports.getUserList = async (req, res) => {
  try {
    const { page = 1, limit = 20, search, role, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;
    const skip = (page - 1) * limit;

    const query = {};
    if (search) {
      query.$or = [
        { walletAddress: { $regex: search, $options: 'i' } },
        { username: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } }
      ];
    }
    if (role) query.role = role;

    const [users, total] = await Promise.all([
      User.find(query)
        .sort({ [sortBy]: sortOrder === 'desc' ? -1 : 1 })
        .skip(skip)
        .limit(parseInt(limit))
        .select('-__v')
        .lean(),
      User.countDocuments(query)
    ]);

    // 각 사용자의 추가 통계 조회
    const usersWithStats = await Promise.all(
      users.map(async (user) => {
        const [fileCount, totalEarned, totalSpent] = await Promise.all([
          File.countDocuments({ creatorId: user._id }),
          File.aggregate([
            { $match: { creatorId: user._id } },
            { $group: { _id: null, total: { $sum: "$totalEarned" } } }
          ]),
          Play.aggregate([
            { $match: { viewerId: user._id, isPaid: true } },
            { $group: { _id: null, total: { $sum: "$amountPaid" } } }
          ])
        ]);

        return {
          ...user,
          stats: {
            files: fileCount,
            earned: totalEarned[0]?.total || 0,
            spent: totalSpent[0]?.total || 0
          }
        };
      })
    );

    res.json({
      success: true,
      users: usersWithStats,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    res.status(500).json({
      error: 'Failed to get user list',
      details: error.message
    });
  }
};

exports.getFileList = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, type, creatorId, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;
    const skip = (page - 1) * limit;

    const query = {};
    if (status) query.status = status;
    if (type) query.fileType = type;
    if (creatorId) query.creatorId = creatorId;

    const [files, total] = await Promise.all([
      File.find(query)
        .populate('creatorId', 'username walletAddress')
        .sort({ [sortBy]: sortOrder === 'desc' ? -1 : 1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      File.countDocuments(query)
    ]);

    // 각 파일의 재생 통계 조회
    const filesWithStats = await Promise.all(
      files.map(async (file) => {
        const [playCount, totalEarned] = await Promise.all([
          Play.countDocuments({ fileId: file._id }),
          Play.aggregate([
            { $match: { fileId: file._id, isPaid: true } },
            { $group: { _id: null, total: { $sum: "$amountPaid" } } }
          ])
        ]);

        return {
          ...file,
          stats: {
            plays: playCount,
            earnings: totalEarned[0]?.total || 0,
            avgWatchTime: file.averageWatchTime || 0
          }
        };
      })
    );

    res.json({
      success: true,
      files: filesWithStats,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    res.status(500).json({
      error: 'Failed to get file list',
      details: error.message
    });
  }
};

exports.updateUser = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { userId } = req.params;
    const updateData = req.body;

    // 업데이트 가능한 필드들만 필터링
    const allowedUpdates = ['username', 'email', 'role', 'isBanned', 'isVerified', 'points'];
    const filteredUpdate = {};
    
    allowedUpdates.forEach(field => {
      if (updateData[field] !== undefined) {
        filteredUpdate[field] = updateData[field];
      }
    });

    const user = await User.findByIdAndUpdate(
      userId,
      { $set: filteredUpdate, updatedAt: new Date() },
      { new: true, runValidators: true }
    ).select('-__v');

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      success: true,
      message: 'User updated successfully',
      user
    });

  } catch (error) {
    res.status(400).json({
      error: 'Failed to update user',
      details: error.message
    });
  }
};

exports.updateFile = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { fileId } = req.params;
    const updateData = req.body;

    const allowedUpdates = ['status', 'pricePerMinute', 'title', 'description', 'tags', 'category'];
    const filteredUpdate = {};
    
    allowedUpdates.forEach(field => {
      if (updateData[field] !== undefined) {
        filteredUpdate[field] = updateData[field];
      }
    });

    const file = await File.findByIdAndUpdate(
      fileId,
      { $set: filteredUpdate, updatedAt: new Date() },
      { new: true, runValidators: true }
    ).populate('creatorId', 'username');

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    res.json({
      success: true,
      message: 'File updated successfully',
      file
    });

  } catch (error) {
    res.status(400).json({
      error: 'Failed to update file',
      details: error.message
    });
  }
};

exports.awardPoints = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { userId, points, reason } = req.body;

    const result = await pointEngine.createTransaction({
      userId,
      transactionType: 'admin_grant',
      points: parseInt(points),
      description: reason || 'Admin grant',
      metadata: { adminAction: true, grantedBy: req.user.id }
    });

    res.json({
      success: true,
      message: 'Points awarded successfully',
      transaction: result
    });

  } catch (error) {
    res.status(400).json({
      error: 'Failed to award points',
      details: error.message
    });
  }
};

exports.getSystemLogs = async (req, res) => {
  try {
    const { type, startDate, endDate, limit = 100 } = req.query;

    // 실제 구현에서는 로깅 시스템에서 조회
    // 임시 로그 데이터 반환
    const mockLogs = [
      {
        timestamp: new Date(),
        type: 'system',
        message: 'System started',
        details: { version: '1.0.0' }
      },
      {
        timestamp: new Date(Date.now() - 3600000),
        type: 'user',
        message: 'New user registered',
        details: { userId: 'user_123', wallet: '0x123...' }
      }
    ];

    res.json({
      success: true,
      logs: mockLogs,
      total: mockLogs.length
    });

  } catch (error) {
    res.status(500).json({
      error: 'Failed to get system logs'
    });
  }
};

exports.cleanupStaleSessions = async (req, res) => {
  try {
    const cleanedCount = await playService.cleanupStaleSessions();

    res.json({
      success: true,
      message: `Cleaned up ${cleanedCount} stale sessions`,
      cleanedCount
    });

  } catch (error) {
    res.status(500).json({
      error: 'Failed to cleanup sessions',
      details: error.message
    });
  }
};

exports.getPlatformSettings = async (req, res) => {
  try {
    const settings = {
      pricing: {
        minPricePerMinute: 0.01,
        maxPricePerMinute: 100,
        platformFeePercent: 5
      },
      points: {
        uploadReward: 100,
        viewRewardPerMinute: 1,
        referralReward: 50,
        dailyCheckin: 5
      },
      limits: {
        maxFileSize: '500MB',
        maxUploadsPerDay: 50,
        maxPlayDuration: 14400 // 4 hours in seconds
      },
      features: {
        tlfEnabled: true,
        streamingEnabled: true,
        walletConnectEnabled: true
      }
    };

    res.json({
      success: true,
      settings,
      lastUpdated: new Date()
    });

  } catch (error) {
    res.status(500).json({
      error: 'Failed to get platform settings'
    });
  }
};
