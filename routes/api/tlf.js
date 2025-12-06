const express = require('express');
const router = express.Router();
const tlfController = require('../../controllers/tlf.controller');
const authMiddleware = require('../../middleware/auth');
const validationMiddleware = require('../../middleware/validation');

// TLF 생성
router.post(
  '/generate/:fileId',
  authMiddleware.verifyToken,
  validationMiddleware.validateTLFCreation,
  validationMiddleware.handleValidation,
  tlfController.generateTLF
);

// TLF 검증
router.get(
  '/verify/:tlfId',
  authMiddleware.verifyToken,
  tlfController.verifyTLF
);

// TLF 정보 조회
router.get(
  '/info/:tlfId',
  tlfController.getTLFInfo
);

// TLF 소유권 이전
router.post(
  '/transfer/:tlfId',
  authMiddleware.verifyToken,
  validationMiddleware.validateTLFTransfer,
  validationMiddleware.handleValidation,
  tlfController.transferTLFOwnership
);

// TLF 가격 업데이트
router.put(
  '/price/:tlfId',
  authMiddleware.verifyToken,
  validationMiddleware.validatePriceUpdate,
  validationMiddleware.handleValidation,
  tlfController.updateTLFPrice
);

// TLF 이력 조회
router.get(
  '/history/:tlfId',
  authMiddleware.verifyToken,
  tlfController.getTLFHistory
);

// 일괄 TLF 생성
router.post(
  '/bulk-generate',
  authMiddleware.verifyToken,
  [
    validationMiddleware.validateArray('fileIds', { maxLength: 10, itemType: 'string' })
  ],
  validationMiddleware.handleValidation,
  tlfController.bulkGenerateTLF
);

// TLF 검색
router.get(
  '/search',
  validationMiddleware.validateSearch,
  validationMiddleware.handleValidation,
  async (req, res) => {
    try {
      const { 
        q: searchTerm, 
        type, 
        category, 
        minPrice, 
        maxPrice, 
        isFree,
        sortBy = 'trending',
        sortOrder = 'desc',
        page = 1, 
        limit = 20 
      } = req.query;
      
      const TLFMetadata = require('../../models/TLFMetadata');
      
      const filters = { type, category, minPrice, maxPrice, isFree };
      const skip = (page - 1) * limit;
      
      let query;
      let sort = {};
      
      if (searchTerm) {
        // 텍스트 검색
        query = TLFMetadata.search(searchTerm, filters);
      } else {
        // 필터 검색
        query = TLFMetadata.find({
          status: 'active',
          ...filters
        });
      }
      
      // 정렬 설정
      switch (sortBy) {
        case 'trending':
          sort = { 'analytics.trendingScore': sortOrder === 'desc' ? -1 : 1 };
          break;
        case 'newest':
          sort = { createdAt: sortOrder === 'desc' ? -1 : 1 };
          break;
        case 'price':
          sort = { 'pricing.pricePerMinute': sortOrder === 'desc' ? -1 : 1 };
          break;
        case 'popular':
          sort = { 'analytics.totalPlays': sortOrder === 'desc' ? -1 : 1 };
          break;
        case 'earnings':
          sort = { 'analytics.totalEarnings': sortOrder === 'desc' ? -1 : 1 };
          break;
        default:
          sort = { 'analytics.trendingScore': -1 };
      }
      
      const [results, total] = await Promise.all([
        query
          .sort(sort)
          .skip(skip)
          .limit(parseInt(limit))
          .lean(),
        searchTerm ? 
          TLFMetadata.countDocuments({ 
            $text: { $search: searchTerm },
            status: 'active',
            ...filters 
          }) :
          TLFMetadata.countDocuments({ 
            status: 'active',
            ...filters 
          })
      ]);
      
      res.json({
        success: true,
        results,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / limit)
        },
        filters: {
          searchTerm,
          type,
          category,
          minPrice,
          maxPrice,
          isFree,
          sortBy,
          sortOrder
        }
      });
      
    } catch (error) {
      console.error('TLF search error:', error);
      res.status(500).json({
        error: 'Search failed',
        details: error.message
      });
    }
  }
);

// 트렌딩 TLF 조회
router.get(
  '/trending',
  async (req, res) => {
    try {
      const { limit = 10, timeRange = 'day' } = req.query;
      const TLFMetadata = require('../../models/TLFMetadata');
      
      const trending = await TLFMetadata.getTrending(parseInt(limit), timeRange);
      
      res.json({
        success: true,
        timeRange,
        results: trending,
        count: trending.length
      });
      
    } catch (error) {
      console.error('Get trending error:', error);
      res.status(500).json({
        error: 'Failed to get trending TLFs'
      });
    }
  }
);

// 크리에이터별 TLF 조회
router.get(
  '/creator/:address',
  async (req, res) => {
    try {
      const { address } = req.params;
      const { 
        status = 'active', 
        page = 1, 
        limit = 20,
        sortBy = 'createdAt',
        sortOrder = 'desc' 
      } = req.query;
      
      const TLFMetadata = require('../../models/TLFMetadata');
      const skip = (page - 1) * limit;
      
      const [tlfList, total] = await Promise.all([
        TLFMetadata.findByCreator(address, {
          status,
          limit: parseInt(limit),
          skip,
          sortBy,
          sortOrder
        }),
        TLFMetadata.countDocuments({ 
          'ownership.creator.address': address.toLowerCase(),
          status 
        })
      ]);
      
      // 크리에이터 정보 가져오기
      const User = require('../../models/User');
      const creator = await User.findOne({ 
        walletAddress: address.toLowerCase() 
      }).select('username avatarUrl bio');
      
      res.json({
        success: true,
        creator: {
          address,
          username: creator?.username,
          avatarUrl: creator?.avatarUrl,
          bio: creator?.bio
        },
        tlfList,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / limit)
        }
      });
      
    } catch (error) {
      console.error('Get creator TLFs error:', error);
      res.status(500).json({
        error: 'Failed to get creator TLFs'
      });
    }
  }
);

// TLF 통계 조회
router.get(
  '/stats/:tlfId',
  authMiddleware.verifyToken,
  async (req, res) => {
    try {
      const { tlfId } = req.params;
      const userId = req.user.id;
      
      const TLFMetadata = require('../../models/TLFMetadata');
      const Play = require('../../models/Play');
      const File = require('../../models/File');
      
      // TLF 정보 조회
      const tlf = await TLFMetadata.findOne({ tlfId });
      if (!tlf) {
        return res.status(404).json({ error: 'TLF not found' });
      }
      
      // 소유권 확인
      const file = await File.findOne({ tlfId });
      if (!file || file.creatorId.toString() !== userId) {
        return res.status(403).json({ error: 'Access denied' });
      }
      
      // 재생 통계
      const playStats = await Play.getFilePlayStats(file._id);
      
      // 시간별 통계 (최근 30일)
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      
      const dailyStats = await Play.aggregate([
        {
          $match: {
            file: file._id,
            startedAt: { $gte: thirtyDaysAgo },
            isCompleted: true
          }
        },
        {
          $group: {
            _id: {
              $dateToString: { format: '%Y-%m-%d', date: '$startedAt' }
            },
            plays: { $sum: 1 },
            totalDuration: { $sum: '$duration' },
            revenue: { $sum: '$payment.amount' },
            avgCompletion: { $avg: '$completionPercentage' }
          }
        },
        { $sort: { '_id': 1 } }
      ]);
      
      // 지리적 통계
      const geographicStats = await Play.aggregate([
        {
          $match: {
            file: file._id,
            isCompleted: true
          }
        },
        {
          $group: {
            _id: '$network.country',
            plays: { $sum: 1 },
            avgDuration: { $avg: '$duration' }
          }
        },
        { $sort: { plays: -1 } },
        { $limit: 10 }
      ]);
      
      // 기기 통계
      const deviceStats = await Play.aggregate([
        {
          $match: {
            file: file._id,
            isCompleted: true,
            'device.type': { $exists: true }
          }
        },
        {
          $group: {
            _id: '$device.type',
            plays: { $sum: 1 },
            percentage: { 
              $avg: { 
                $multiply: ['$completionPercentage', 100] 
              } 
            }
          }
        },
        { $sort: { plays: -1 } }
      ]);
      
      res.json({
        success: true,
        tlfId,
        overview: playStats[0] || {},
        dailyStats,
        geographicStats,
        deviceStats,
        summary: {
          totalEarnings: tlf.analytics.totalEarnings,
          totalPlays: tlf.analytics.totalPlays,
          uniqueViewers: tlf.analytics.uniqueViewers,
          avgWatchTime: tlf.analytics.avgWatchTime,
          trendingScore: tlf.analytics.trendingScore
        }
      });
      
    } catch (error) {
      console.error('Get TLF stats error:', error);
      res.status(500).json({
        error: 'Failed to get TLF statistics'
      });
    }
  }
);

// TLF 상태 업데이트
router.patch(
  '/:tlfId/status',
  authMiddleware.verifyToken,
  [
    validationMiddleware.validateMongoId('tlfId')[0],
    body('status')
      .isIn(['active', 'suspended', 'archived'])
      .withMessage('Invalid status')
  ],
  validationMiddleware.handleValidation,
  async (req, res) => {
    try {
      const { tlfId } = req.params;
      const { status } = req.body;
      const userId = req.user.id;
      
      const File = require('../../models/File');
      const TLFMetadata = require('../../models/TLFMetadata');
      
      // 파일 및 소유권 확인
      const file = await File.findOne({ tlfId, creatorId: userId });
      if (!file) {
        return res.status(404).json({ 
          error: 'TLF not found or access denied' 
        });
      }
      
      // 상태 업데이트
      const updates = { status };
      
      if (status === 'archived') {
        updates.archivedAt = new Date();
      } else if (status === 'active' && file.status === 'archived') {
        updates.publishedAt = new Date();
      }
      
      const [updatedFile, updatedMetadata] = await Promise.all([
        File.findByIdAndUpdate(
          file._id,
          { $set: updates },
          { new: true }
        ),
        TLFMetadata.findOneAndUpdate(
          { tlfId },
          { $set: { status } },
          { new: true }
        )
      ]);
      
      res.json({
        success: true,
        message: `TLF status updated to ${status}`,
        file: updatedFile,
        metadata: updatedMetadata
      });
      
    } catch (error) {
      console.error('Update TLF status error:', error);
      res.status(500).json({
        error: 'Failed to update TLF status'
      });
    }
  }
);

module.exports = router;
