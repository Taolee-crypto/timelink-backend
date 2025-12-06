const User = require('../models/User');
const File = require('../models/File');
const Play = require('../models/Play');
const pointEngine = require('./point-engine');
const { ethers } = require('ethers');
const constants = require('../config/constants');

class SettlementService {
  constructor() {
    this.provider = new ethers.JsonRpcProvider(
      process.env.BLOCKCHAIN_RPC_URL || 'http://localhost:8545'
    );
    this.wallet = new ethers.Wallet(
      process.env.SETTLEMENT_WALLET_PRIVATE_KEY || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      this.provider
    );
  }

  async processPayment({ sessionId, userId, fileId, amount, duration }) {
    try {
      // 1. 세션 및 파일 정보 확인
      const [session, file, user] = await Promise.all([
        Play.findById(sessionId),
        File.findById(fileId).populate('creatorId'),
        User.findById(userId)
      ]);

      if (!session || !file || !user) {
        throw new Error('Invalid session, file, or user');
      }

      // 2. 결제 금액 검증
      const calculatedAmount = this.calculateAmount(duration, file.pricePerMinute);
      if (Math.abs(calculatedAmount - amount) > 0.001) {
        throw new Error('Amount mismatch');
      }

      // 3. 블록체인 결제 시뮬레이션 (실제 구현에서는 실제 트랜잭션)
      const txHash = await this.simulateBlockchainPayment({
        from: user.walletAddress,
        to: file.creatorId?.walletAddress || file.creatorAddress,
        amount: amount,
        fileId: file.tlfId,
        sessionId: sessionId.toString()
      });

      // 4. 수수료 계산 및 분배
      const { platformFee, creatorAmount } = this.calculateDistribution(amount);

      // 5. 데이터베이스 업데이트
      await this.updateSettlementRecords({
        sessionId,
        userId,
        fileId,
        creatorId: file.creatorId,
        amount,
        platformFee,
        creatorAmount,
        txHash
      });

      // 6. 포인트 시스템 업데이트
      await pointEngine.processPurchase(userId, amount, fileId);
      await pointEngine.processSale(file.creatorId, creatorAmount, fileId);

      // 7. 통계 업데이트
      await this.updateStatistics(userId, file.creatorId, amount, creatorAmount);

      return {
        success: true,
        txHash,
        amount,
        platformFee,
        creatorAmount,
        timestamp: new Date()
      };

    } catch (error) {
      console.error('Payment processing error:', error);
      throw error;
    }
  }

  calculateAmount(durationSeconds, pricePerMinute) {
    const minutes = durationSeconds / 60;
    let amount = minutes * pricePerMinute;
    
    // 최소 결제 금액
    amount = Math.max(amount, 0.01);
    // 소수점 4자리까지 반올림
    amount = Math.round(amount * 10000) / 10000;
    
    return amount;
  }

  calculateDistribution(amount) {
    const platformFeePercent = constants.PRICING.PLATFORM_FEE_PERCENT;
    const platformFee = (amount * platformFeePercent) / 100;
    const creatorAmount = amount - platformFee;
    
    return {
      platformFee: Math.round(platformFee * 10000) / 10000,
      creatorAmount: Math.round(creatorAmount * 10000) / 10000
    };
  }

  async simulateBlockchainPayment({ from, to, amount, fileId, sessionId }) {
    // 실제 구현에서는:
    // 1. 스마트 컨트랙트 호출
    // 2. TLT 토큰 전송
    // 3. 트랜잭션 해시 반환
    
    // 임시 시뮬레이션
    const mockTxHash = `0x${Array.from({ length: 64 }, () => 
      Math.floor(Math.random() * 16).toString(16)
    ).join('')}`;
    
    console.log(`Payment simulation:
      From: ${from}
      To: ${to}
      Amount: ${amount} TLT
      File: ${fileId}
      Session: ${sessionId}
      TxHash: ${mockTxHash}
    `);
    
    return mockTxHash;
  }

  async updateSettlementRecords({ sessionId, userId, fileId, creatorId, amount, platformFee, creatorAmount, txHash }) {
    const now = new Date();

    // 세션 업데이트
    await Play.findByIdAndUpdate(sessionId, {
      amountPaid: amount,
      isPaid: true,
      paymentTxHash: txHash
    });

    // 파일 수익 업데이트
    await File.findByIdAndUpdate(fileId, {
      $inc: { totalEarned: creatorAmount }
    });

    // 사용자 통계 업데이트
    await Promise.all([
      // 시청자 지출 통계
      User.findByIdAndUpdate(userId, {
        $inc: { totalSpent: amount }
      }),
      // 크리에이터 수익 통계
      User.findByIdAndUpdate(creatorId, {
        $inc: { totalEarned: creatorAmount }
      })
    ]);

    // 정산 기록 생성 (별도의 Settlement 모델이 있다면)
    console.log(`Settlement recorded:
      Session: ${sessionId}
      User: ${userId}
      Creator: ${creatorId}
      Amount: ${amount}
      Platform Fee: ${platformFee}
      Creator Amount: ${creatorAmount}
      Tx: ${txHash}
    `);
  }

  async updateStatistics(userId, creatorId, amount, creatorAmount) {
    // 추가 통계 업데이트 로직
    // 예: 일별/월별 통계, 랭킹 등
  }

  async getUserBalance(walletAddress) {
    try {
      // 실제 구현에서는 블록체인에서 잔액 조회
      const mockBalance = {
        tlt: 100.5, // TLT 잔액
        points: 250, // 포인트 잔액
        pending: 5.2 // 처리 중인 수익
      };

      return {
        success: true,
        wallet: walletAddress,
        balances: mockBalance,
        lastUpdated: new Date()
      };
    } catch (error) {
      throw new Error(`Failed to get balance: ${error.message}`);
    }
  }

  async withdrawEarnings(userId, amount) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      if (user.totalEarned < amount) {
        throw new Error('Insufficient earnings');
      }

      // 출금 시뮬레이션
      const txHash = await this.simulateWithdrawal({
        to: user.walletAddress,
        amount
      });

      // 사용자 통계 업데이트
      await User.findByIdAndUpdate(userId, {
        $inc: { totalEarned: -amount }
      });

      return {
        success: true,
        txHash,
        amount,
        timestamp: new Date()
      };

    } catch (error) {
      console.error('Withdrawal error:', error);
      throw error;
    }
  }

  async simulateWithdrawal({ to, amount }) {
    const mockTxHash = `0x${Array.from({ length: 64 }, () => 
      Math.floor(Math.random() * 16).toString(16)
    ).join('')}_withdraw`;
    
    console.log(`Withdrawal simulation:
      To: ${to}
      Amount: ${amount} TLT
      TxHash: ${mockTxHash}
    `);
    
    return mockTxHash;
  }

  async getSettlementHistory(userId, options = {}) {
    const { page = 1, limit = 20, type } = options;
    
    // 실제 구현에서는 Settlement 모델에서 조회
    const mockHistory = [
      {
        type: 'earning',
        amount: 1.5,
        fileTitle: 'Blockchain Tutorial',
        date: new Date(Date.now() - 86400000), // 1일 전
        status: 'completed'
      },
      {
        type: 'withdrawal',
        amount: -10.0,
        description: 'Withdrawal to wallet',
        date: new Date(Date.now() - 172800000), // 2일 전
        status: 'completed'
      }
    ];

    return {
      history: mockHistory,
      summary: {
        totalEarned: 15.5,
        totalWithdrawn: 10.0,
        available: 5.5
      }
    };
  }
}

module.exports = new SettlementService();
