const PointLedger = require('../models/PointLedger');
const User = require('../models/User');
const constants = require('../config/constants');

class PointEngine {
  constructor() {
    this.pointConfig = constants.POINTS;
  }

  async awardUploadPoints(userId, fileId) {
    return this.createTransaction({
      userId,
      transactionType: 'upload_reward',
      points: this.pointConfig.UPLOAD_REWARD,
      description: 'Reward for uploading new content',
      metadata: { fileId },
      expiresAt: this.calculateExpiryDate(30) // 30일 후 만료
    });
  }

  async awardViewPoints(userId, fileId, durationSeconds) {
    const points = this.calculateViewPoints(durationSeconds);
    
    if (points > 0) {
      return this.createTransaction({
        userId,
        transactionType: 'view_reward',
        points,
        description: 'Reward for watching content',
        metadata: { fileId, durationSeconds },
        expiresAt: this.calculateExpiryDate(7) // 7일 후 만료
      });
    }
    return null;
  }

  async awardReferralPoints(userId, referrerId) {
    return this.createTransaction({
      userId: referrerId,
      transactionType: 'referral_bonus',
      points: this.pointConfig.REFERRAL_REWARD,
      description: 'Referral bonus',
      metadata: { referredUserId: userId },
      expiresAt: this.calculateExpiryDate(90) // 90일 후 만료
    });
  }

  async awardDailyCheckin(userId) {
    // 하루에 한 번만 받을 수 있도록 체크
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const existing = await PointLedger.findOne({
      userId,
      transactionType: 'daily_checkin',
      createdAt: { $gte: today }
    });

    if (existing) {
      throw new Error('Daily checkin already claimed today');
    }

    return this.createTransaction({
      userId,
      transactionType: 'daily_checkin',
      points: this.pointConfig.DAILY_CHECKIN,
      description: 'Daily checkin reward',
      expiresAt: this.calculateExpiryDate(7)
    });
  }

  async processPurchase(userId, amount, fileId) {
    return this.createTransaction({
      userId,
      transactionType: 'purchase_spent',
      points: -amount, // 음수: 지출
      description: 'Purchase content',
      metadata: { fileId, amount },
      expiresAt: null // 지출은 만료 없음
    });
  }

  async processSale(creatorId, amount, fileId) {
    return this.createTransaction({
      userId: creatorId,
      transactionType: 'sale_earned',
      points: amount,
      description: 'Earned from content sale',
      metadata: { fileId, amount },
      expiresAt: null // 수익은 만료 없음
    });
  }

  calculateViewPoints(durationSeconds) {
    if (durationSeconds < 60) return 0; // 1분 미만 시청 무시
    
    const minutes = Math.floor(durationSeconds / 60);
    // 1분당 1포인트, 최대 100포인트
    return Math.min(minutes * 1, 100);
  }

  calculateExpiryDate(days) {
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + days);
    return expiry;
  }

  async createTransaction({ userId, transactionType, points, description, metadata, expiresAt }) {
    // 현재 잔액 확인
    const user = await User.findById(userId);
    const balanceBefore = user?.points || 0;
    const balanceAfter = balanceBefore + points;

    // 포인트 원장 생성
    const ledger = new PointLedger({
      userId,
      userAddress: user?.walletAddress,
      transactionType,
      points,
      balanceBefore,
      balanceAfter,
      description,
      metadata,
      expiresAt
    });

    await ledger.save();

    // 사용자 포인트 업데이트
    await User.findByIdAndUpdate(userId, {
      $inc: { points: points },
      $set: { updatedAt: new Date() }
    });

    return {
      ledgerId: ledger._id,
      points,
      balanceBefore,
      balanceAfter,
      transactionType,
      expiresAt
    };
  }

  async getUserBalance(userId) {
    const user = await User.findById(userId).select('points');
    
    // 만료된 포인트 정리
    await this.cleanupExpiredPoints(userId);

    return {
      total: user?.points || 0,
      available: await this.getAvailablePoints(userId),
      pendingExpiry: await this.getPendingExpiryPoints(userId)
    };
  }

  async getAvailablePoints(userId) {
    // 만료되지 않은 포인트 합계
    const result = await PointLedger.aggregate([
      {
        $match: {
          userId: userId,
          $or: [
            { expiresAt: null },
            { expiresAt: { $gt: new Date() } }
          ]
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$points" }
        }
      }
    ]);

    return result.length > 0 ? Math.max(result[0].total, 0) : 0;
  }

  async getPendingExpiryPoints(userId) {
    // 7일 이내 만료 예정인 포인트
    const sevenDaysFromNow = new Date();
    sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);

    const result = await PointLedger.aggregate([
      {
        $match: {
          userId: userId,
          expiresAt: { 
            $ne: null,
            $lte: sevenDaysFromNow,
            $gt: new Date()
          },
          points: { $gt: 0 }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$points" }
        }
      }
    ]);

    return result.length > 0 ? result[0].total : 0;
  }

  async cleanupExpiredPoints(userId) {
    const now = new Date();
    
    // 만료된 포인트 찾기
    const expired = await PointLedger.find({
      userId,
      expiresAt: { $lte: now, $ne: null },
      points: { $gt: 0 }
    });

    if (expired.length > 0) {
      const totalExpired = expired.reduce((sum, entry) => sum + entry.points, 0);
      
      // 만료 처리 원장 생성
      for (const entry of expired) {
        await this.createTransaction({
          userId,
          transactionType: 'expired',
          points: -entry.points,
          description: 'Points expired',
          metadata: { expiredLedgerId: entry._id },
          expiresAt: null
        });
      }

      return { expiredCount: expired.length, totalExpired };
    }

    return { expiredCount: 0, totalExpired: 0 };
  }

  async getTransactionHistory(userId, options = {}) {
    const { page = 1, limit = 50, type } = options;
    const skip = (page - 1) * limit;

    const query = { userId };
    if (type) query.transactionType = type;

    const [transactions, total] = await Promise.all([
      PointLedger.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      PointLedger.countDocuments(query)
    ]);

    return {
      transactions,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    };
  }
}

module.exports = new PointEngine();
