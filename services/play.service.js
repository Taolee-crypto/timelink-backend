const Play = require('../models/Play');
const File = require('../models/File');
const User = require('../models/User');
const pointEngine = require('./point-engine');
const settlementService = require('./settlement.service');

class PlayService {
  constructor() {
    this.activeSessions = new Map();
  }

  async startPlayback({ tlfId, fileId, userId, userAddress, device, ipAddress }) {
    try {
      // 1. 파일 정보 확인
      const file = await File.findOne({
        $or: [{ tlfId }, { _id: fileId }],
        status: 'ready'
      });

      if (!file) {
        throw new Error('File not found or not ready for playback');
      }

      // 2. 무료 콘텐츠인지 확인
      if (file.isFree) {
        // 무료 콘텐츠는 세션만 생성
        const freeSession = new Play({
          fileId: file._id,
          tlfId: file.tlfId,
          viewerId: userId,
          viewerAddress: userAddress,
          pricePerMinute: 0,
          amountPaid: 0,
          isPaid: true,
          device,
          ipAddress,
          status: 'playing'
        });

        await freeSession.save();
        
        // 포인트 적립 (무료 시청 보상)
        await pointEngine.awardViewPoints(userId, file._id, 0);

        return {
          _id: freeSession._id,
          playbackUrl: file.storageUrl,
          priceInfo: {
            isFree: true,
            pricePerMinute: 0,
            estimatedCost: 0
          }
        };
      }

      // 3. 유료 콘텐츠 - 세션 생성 및 결제 준비
      const session = new Play({
        fileId: file._id,
        tlfId: file.tlfId,
        viewerId: userId,
        viewerAddress: userAddress,
        pricePerMinute: file.pricePerMinute,
        device,
        ipAddress,
        status: 'playing'
      });

      await session.save();

      // 4. 활성 세션 관리
      this.activeSessions.set(session._id.toString(), {
        sessionId: session._id,
        startTime: new Date(),
        fileId: file._id,
        userId,
        pricePerMinute: file.pricePerMinute,
        lastUpdate: new Date()
      });

      return {
        _id: session._id,
        playbackUrl: file.storageUrl,
        priceInfo: {
          isFree: false,
          pricePerMinute: file.pricePerMinute,
          estimatedCost: file.pricePerMinute * 0.5 // 30초 기준 예상 비용
        }
      };

    } catch (error) {
      console.error('Start playback error:', error);
      throw error;
    }
  }

  async updatePlayback(sessionId, userId, { position, status }) {
    try {
      const session = await Play.findOne({
        _id: sessionId,
        viewerId: userId
      });

      if (!session) {
        throw new Error('Playback session not found');
      }

      // 위치 업데이트
      if (position !== undefined) {
        session.currentPosition = position;
      }

      // 상태 업데이트
      if (status) {
        session.status = status;
      }

      session.updatedAt = new Date();
      await session.save();

      // 활성 세션 업데이트
      if (this.activeSessions.has(sessionId)) {
        const activeSession = this.activeSessions.get(sessionId);
        activeSession.lastUpdate = new Date();
        if (position) {
          activeSession.lastPosition = position;
        }
      }

      return session;

    } catch (error) {
      console.error('Update playback error:', error);
      throw error;
    }
  }

  async finishPlayback(sessionId, userId) {
    try {
      const session = await Play.findOne({
        _id: sessionId,
        viewerId: userId
      });

      if (!session) {
        throw new Error('Playback session not found');
      }

      // 1. 재생 시간 계산
      const endTime = new Date();
      const duration = Math.floor((endTime - session.startTime) / 1000); // 초 단위
      
      session.endTime = endTime;
      session.duration = duration;
      session.status = 'finished';

      // 2. 유료 콘텐츠인 경우 결제 처리
      let paymentResult = null;
      if (!session.isPaid && session.pricePerMinute > 0) {
        const cost = this.calculateCost(duration, session.pricePerMinute);
        
        if (cost > 0) {
          paymentResult = await settlementService.processPayment({
            sessionId: session._id,
            userId,
            fileId: session.fileId,
            amount: cost,
            duration
          });

          session.amountPaid = cost;
          session.isPaid = true;
          session.paymentTxHash = paymentResult.txHash;
        }
      }

      // 3. 세션 저장
      await session.save();

      // 4. 활성 세션에서 제거
      this.activeSessions.delete(sessionId);

      // 5. 포인트 적립 (시청 보상)
      const pointsEarned = await pointEngine.awardViewPoints(
        userId, 
        session.fileId, 
        duration
      );

      // 6. 콘텐츠 조회수 업데이트
      await File.findByIdAndUpdate(session.fileId, {
        $inc: { viewCount: 1 },
        $set: { 
          totalEarned: await this.calculateTotalEarned(session.fileId)
        }
      });

      return {
        payment: paymentResult,
        pointsEarned,
        duration,
        totalCost: session.amountPaid || 0
      };

    } catch (error) {
      console.error('Finish playback error:', error);
      throw error;
    }
  }

  calculateCost(durationSeconds, pricePerMinute) {
    const minutes = durationSeconds / 60;
    const cost = minutes * pricePerMinute;
    // 최소 결제 금액 (0.01 TLT)
    return Math.max(cost, 0.01);
  }

  async calculateTotalEarned(fileId) {
    const result = await Play.aggregate([
      {
        $match: {
          fileId: fileId,
          isPaid: true
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$amountPaid" }
        }
      }
    ]);

    return result.length > 0 ? result[0].total : 0;
  }

  async getUserPlaybackHistory(userId, options = {}) {
    const { page = 1, limit = 20, fileId } = options;
    const skip = (page - 1) * limit;

    const query = { viewerId: userId };
    if (fileId) query.fileId = fileId;

    const [items, total] = await Promise.all([
      Play.find(query)
        .populate('fileId', 'title thumbnailUrl pricePerMinute')
        .sort({ startTime: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Play.countDocuments(query)
    ]);

    return {
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    };
  }

  async getActiveSessions(userId) {
    const sessions = await Play.find({
      viewerId: userId,
      status: { $in: ['playing', 'paused'] }
    }).populate('fileId', 'title thumbnailUrl');

    return sessions;
  }

  // 정기적으로 정리되지 않은 세션 처리
  async cleanupStaleSessions() {
    const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24시간 전
    
    const staleSessions = await Play.find({
      status: { $in: ['playing', 'paused'] },
      updatedAt: { $lt: cutoffTime }
    });

    for (const session of staleSessions) {
      try {
        await this.finishPlayback(session._id, session.viewerId);
      } catch (error) {
        console.error(`Error cleaning up session ${session._id}:`, error);
      }
    }

    return staleSessions.length;
  }
}

module.exports = new PlayService();
