const settlementService = require('../services/settlement.service');
const pointEngine = require('../services/point-engine');
const User = require('../models/User');
const { validationResult } = require('express-validator');

exports.getWalletInfo = async (req, res) => {
  try {
    const userId = req.user.id;
    const userAddress = req.user.address;

    const [user, pointBalance, blockchainBalance] = await Promise.all([
      User.findById(userId).select('walletAddress totalEarned totalSpent'),
      pointEngine.getUserBalance(userId),
      settlementService.getUserBalance(userAddress)
    ]);

    res.json({
      success: true,
      wallet: {
        address: user.walletAddress,
        balances: {
          ...blockchainBalance.balances,
          points: pointBalance.total
        },
        statistics: {
          totalEarned: user.totalEarned,
          totalSpent: user.totalSpent,
          availableEarnings: user.totalEarned - (await this.getTotalWithdrawn(userId))
        },
        pointDetails: {
          available: pointBalance.available,
          pendingExpiry: pointBalance.pendingExpiry
        }
      }
    });

  } catch (error) {
    res.status(500).json({
      error: 'Failed to get wallet info',
      details: error.message
    });
  }
};

exports.getPointHistory = async (req, res) => {
  try {
    const userId = req.user.id;
    const { page = 1, limit = 50, type } = req.query;

    const history = await pointEngine.getTransactionHistory(userId, {
      page: parseInt(page),
      limit: parseInt(limit),
      type
    });

    res.json({
      success: true,
      ...history
    });

  } catch (error) {
    res.status(500).json({
      error: 'Failed to get point history',
      details: error.message
    });
  }
};

exports.getSettlementHistory = async (req, res) => {
  try {
    const userId = req.user.id;
    const { page = 1, limit = 20, type } = req.query;

    const history = await settlementService.getSettlementHistory(userId, {
      page: parseInt(page),
      limit: parseInt(limit),
      type
    });

    res.json({
      success: true,
      ...history
    });

  } catch (error) {
    res.status(500).json({
      error: 'Failed to get settlement history',
      details: error.message
    });
  }
};

exports.requestWithdrawal = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const userId = req.user.id;
    const { amount } = req.body;

    // 최소 출금 금액 검증
    if (amount < 1.0) {
      return res.status(400).json({
        error: 'Minimum withdrawal amount is 1.0 TLT'
      });
    }

    const result = await settlementService.withdrawEarnings(userId, amount);

    res.json({
      success: true,
      message: 'Withdrawal requested successfully',
      transaction: result
    });

  } catch (error) {
    res.status(400).json({
      error: 'Withdrawal failed',
      details: error.message
    });
  }
};

exports.dailyCheckin = async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await pointEngine.awardDailyCheckin(userId);

    res.json({
      success: true,
      message: 'Daily checkin successful!',
      pointsAwarded: result.points,
      newBalance: result.balanceAfter
    });

  } catch (error) {
    if (error.message.includes('already claimed')) {
      return res.status(400).json({
        error: 'Daily checkin already claimed today'
      });
    }
    
    res.status(500).json({
      error: 'Daily checkin failed',
      details: error.message
    });
  }
};

exports.getRewardSummary = async (req, res) => {
  try {
    const userId = req.user.id;
    
    const pointHistory = await pointEngine.getTransactionHistory(userId, { limit: 100 });
    
    const summary = this.calculateRewardSummary(pointHistory.transactions);

    res.json({
      success: true,
      summary
    });

  } catch (error) {
    res.status(500).json({
      error: 'Failed to get reward summary'
    });
  }
};

exports.connectWallet = async (req, res) => {
  try {
    const { walletAddress, signature, message } = req.body;
    
    // 서명 검증 (실제 구현에서는 블록체인 서명 검증)
    const isValidSignature = await this.verifySignature(
      walletAddress,
      signature,
      message
    );

    if (!isValidSignature) {
      return res.status(401).json({
        error: 'Invalid signature'
      });
    }

    // 사용자 찾기 또는 생성
    let user = await User.findOne({ walletAddress: walletAddress.toLowerCase() });
    
    if (!user) {
      user = new User({
        walletAddress: walletAddress.toLowerCase(),
        username: `user_${walletAddress.slice(2, 8)}`,
        role: 'user',
        isVerified: true
      });
      await user.save();
    } else {
      user.lastLogin = new Date();
      await user.save();
    }

    // JWT 토큰 생성
    const token = this.generateToken(user);

    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        address: user.walletAddress,
        username: user.username,
        role: user.role
      }
    });

  } catch (error) {
    res.status(500).json({
      error: 'Wallet connection failed',
      details: error.message
    });
  }
};

// 헬퍼 메서드들
calculateRewardSummary(transactions) {
  const summary = {
    totalPoints: 0,
    byType: {},
    recentActivities: []
  };

  transactions.forEach(tx => {
    summary.totalPoints += tx.points > 0 ? tx.points : 0;
    
    if (!summary.byType[tx.transactionType]) {
      summary.byType[tx.transactionType] = 0;
    }
    summary.byType[tx.transactionType] += tx.points;
    
    if (tx.points > 0) {
      summary.recentActivities.push({
        type: tx.transactionType,
        points: tx.points,
        date: tx.createdAt,
        description: tx.description
      });
    }
  });

  // 최근 활동 5개만
  summary.recentActivities = summary.recentActivities
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 5);

  return summary;
}

async verifySignature(address, signature, message) {
  // 실제 구현에서는 ethers.js를 사용한 서명 검증
  // 임시로 항상 true 반환 (개발용)
  return true;
}

generateToken(user) {
  // 실제 구현에서는 JWT 생성
  const mockToken = `mock_jwt_${user._id}_${Date.now()}`;
  return mockToken;
}

async getTotalWithdrawn(userId) {
  // 실제 구현에서는 Withdrawal 모델에서 조회
  return 0;
}
