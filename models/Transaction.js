const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  // 트랜잭션 식별자
  transactionId: {
    type: String,
    unique: true,
    required: true,
    index: true
  },
  
  // 블록체인 트랜잭션 정보
  blockchain: {
    txHash: {
      type: String,
      unique: true,
      sparse: true,
      index: true
    },
    blockNumber: Number,
    blockHash: String,
    from: {
      type: String,
      required: true,
      index: true
    },
    to: {
      type: String,
      required: true,
      index: true
    },
    chainId: {
      type: Number,
      required: true
    },
    network: {
      type: String,
      required: true
    },
    gasUsed: String,
    gasPrice: String,
    nonce: Number,
    timestamp: Date
  },
  
  // 트랜잭션 타입
  type: {
    type: String,
    enum: [
      'TLT_TRANSFER',      // TLT 토큰 전송
      'TLF_PURCHASE',      // TLF 구매
      'TLF_SALE',          // TLF 판매
      'ROYALTY_PAYMENT',   // 로열티 지급
      'PLATFORM_FEE',      // 플랫폼 수수료
      'WITHDRAWAL',        // 출금
      'DEPOSIT',           // 입금
      'STAKING_REWARD',    // 스테이킹 보상
      'REFERRAL_BONUS',    // 추천 보너스
      'ADMIN_MINT',        // 관리자 발행
      'CONTRACT_CALL',     // 컨트랙트 호출
      'OTHER'              // 기타
    ],
    required: true,
    index: true
  },
  
  // 금액 정보
  amount: {
    value: {
      type: String, // BigNumber를 문자열로 저장
      required: true
    },
    decimals: {
      type: Number,
      default: 18
    },
    currency: {
      type: String,
      default: 'TLT'
    },
    formatted: String // 사람이 읽기 쉬운 형식
  },
  
  // 관련 엔티티
  relatedEntities: {
    fileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'File',
      index: true
    },
    tlfId: {
      type: String,
      index: true
    },
    playId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Play',
      index: true
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true
    }
  },
  
  // 메타데이터
  metadata: {
    description: String,
    notes: String,
    invoiceId: String,
    paymentMethod: String,
    feeBreakdown: {
      platform: String,
      network: String,
      royalty: String
    },
    customData: mongoose.Schema.Types.Mixed
  },
  
  // 상태 정보
  status: {
    type: String,
    enum: ['pending', 'processing', 'confirmed', 'failed', 'reverted', 'cancelled'],
    default: 'pending',
    index: true
  },
  confirmations: {
    type: Number,
    default: 0
  },
  requiredConfirmations: {
    type: Number,
    default: 12
  },
  
  // 에러 정보
  error: {
    code: String,
    message: String,
    details: mongoose.Schema.Types.Mixed,
    blockchainError: String
  },
  
  // 재시도 정보
  retry: {
    count: {
      type: Number,
      default: 0
    },
    maxRetries: {
      type: Number,
      default: 3
    },
    lastRetry: Date,
    nextRetry: Date
  },
  
  // 웹훅 정보
  webhook: {
    sent: {
      type: Boolean,
      default: false
    },
    url: String,
    attempts: {
      type: Number,
      default: 0
    },
    lastAttempt: Date,
    response: mongoose.Schema.Types.Mixed
  },
  
  // 검증 정보
  verification: {
    verified: {
      type: Boolean,
      default: false
    },
    verifiedBy: String,
    verifiedAt: Date,
    signature: String,
    signedMessage: String
  },
  
  // 보안 정보
  security: {
    ipAddress: String,
    userAgent: String,
    deviceId: String,
    riskScore: {
      type: Number,
      min: 0,
      max: 100,
      default: 0
    },
    flags: [String] // ['high_value', 'suspicious', 'first_transaction']
  },
  
  // 시스템 정보
  system: {
    createdBy: String, // 'user', 'system', 'admin', 'api'
    source: String, // 'web', 'mobile', 'api', 'cron'
    processor: String, // 처리 서비스 이름
    batchId: String // 배치 처리 ID
  },
  
  // 시간 정보
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  updatedAt: {
    type: Date,
    default: Date.now
  },
  confirmedAt: Date,
  completedAt: Date,
  failedAt: Date
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// 인덱스 설정
transactionSchema.index({ 'blockchain.from': 1, createdAt: -1 });
transactionSchema.index({ 'blockchain.to': 1, createdAt: -1 });
transactionSchema.index({ type: 1, status: 1 });
transactionSchema.index({ 'relatedEntities.userId': 1, createdAt: -1 });
transactionSchema.index({ 'relatedEntities.fileId': 1, type: 1 });
transactionSchema.index({ status: 1, 'retry.nextRetry': 1 });
transactionSchema.index({ 'blockchain.timestamp': -1 });

// 가상 필드
transactionSchema.virtual('isConfirmed').get(function() {
  return this.status === 'confirmed' && this.confirmations >= this.requiredConfirmations;
});

transactionSchema.virtual('numericAmount').get(function() {
  const value = parseFloat(this.amount.value);
  const decimals = this.amount.decimals || 18;
  return value / Math.pow(10, decimals);
});

transactionSchema.virtual('isLargeTransaction').get(function() {
  const amount = this.numericAmount;
  return amount > 1000; // 1000 TLT 이상 대형 거래
});

// 메서드
transactionSchema.methods.markAsProcessing = function() {
  this.status = 'processing';
  this.updatedAt = new Date();
  return this;
};

transactionSchema.methods.confirm = function(confirmations) {
  this.confirmations = confirmations;
  
  if (confirmations >= this.requiredConfirmations) {
    this.status = 'confirmed';
    this.confirmedAt = new Date();
  }
  
  this.updatedAt = new Date();
  return this;
};

transactionSchema.methods.fail = function(error) {
  this.status = 'failed';
  this.failedAt = new Date();
  this.error = {
    message: error.message,
    code: error.code,
    details: error.details,
    blockchainError: error.blockchainError
  };
  
  // 재시도 설정
  if (this.retry.count < this.retry.maxRetries) {
    this.retry.count += 1;
    const delay = Math.pow(2, this.retry.count) * 5000; // Exponential backoff
    this.retry.nextRetry = new Date(Date.now() + delay);
    this.status = 'pending';
  }
  
  this.updatedAt = new Date();
  return this;
};

transactionSchema.methods.complete = function() {
  this.status = 'confirmed';
  this.completedAt = new Date();
  this.updatedAt = new Date();
  return this;
};

transactionSchema.methods.recordWebhookAttempt = function(response) {
  this.webhook.attempts += 1;
  this.webhook.lastAttempt = new Date();
  this.webhook.response = response;
  
  if (response && response.status >= 200 && response.status < 300) {
    this.webhook.sent = true;
  }
  
  this.updatedAt = new Date();
  return this;
};

// 정적 메서드
transactionSchema.statics.findByAddress = function(address, options = {}) {
  const { limit = 50, skip = 0, type, status, startDate, endDate } = options;
  
  const query = {
    $or: [
      { 'blockchain.from': address.toLowerCase() },
      { 'blockchain.to': address.toLowerCase() }
    ]
  };
  
  if (type) query.type = type;
  if (status) query.status = status;
  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) query.createdAt.$gte = new Date(startDate);
    if (endDate) query.createdAt.$lte = new Date(endDate);
  }
  
  return this.find(query)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate('relatedEntities.userId', 'username walletAddress')
    .populate('relatedEntities.fileId', 'title tlfId');
};

transactionSchema.statics.findPendingTransactions = function(limit = 100) {
  return this.find({
    status: { $in: ['pending', 'processing'] },
    $or: [
      { 'retry.nextRetry': { $lt: new Date() } },
      { 'retry.nextRetry': { $exists: false } }
    ]
  })
  .sort({ createdAt: 1 })
  .limit(limit);
};

transactionSchema.statics.getTransactionStats = function(timeRange = 'day') {
  const startDate = new Date();
  
  switch (timeRange) {
    case 'hour':
      startDate.setHours(startDate.getHours() - 1);
      break;
    case 'day':
      startDate.setDate(startDate.getDate() - 1);
      break;
    case 'week':
      startDate.setDate(startDate.getDate() - 7);
      break;
    case 'month':
      startDate.setMonth(startDate.getMonth() - 1);
      break;
    default:
      startDate.setDate(startDate.getDate() - 1);
  }
  
  return this.aggregate([
    {
      $match: {
        createdAt: { $gte: startDate },
        status: 'confirmed'
      }
    },
    {
      $group: {
        _id: {
          type: '$type',
          date: {
            $dateToString: { format: '%Y-%m-%d', date: '$createdAt' }
          }
        },
        count: { $sum: 1 },
        totalAmount: { 
          $sum: {
            $divide: [
              { $toDouble: '$amount.value' },
              { $pow: [10, { $ifNull: ['$amount.decimals', 18] }] }
            ]
          }
        },
        uniqueUsers: { $addToSet: '$blockchain.from' },
        uniqueReceivers: { $addToSet: '$blockchain.to' }
      }
    },
    {
      $group: {
        _id: '$_id.type',
        dailyStats: {
          $push: {
            date: '$_id.date',
            count: '$count',
            totalAmount: '$totalAmount'
          }
        },
        totalCount: { $sum: '$count' },
        totalAmount: { $sum: '$totalAmount' },
        uniqueSenders: { $addToSet: { $arrayElemAt: ['$uniqueUsers', 0] } },
        uniqueReceivers: { $addToSet: { $arrayElemAt: ['$uniqueReceivers', 0] } }
      }
    },
    {
      $project: {
        type: '$_id',
        dailyStats: 1,
        totalCount: 1,
        totalAmount: 1,
        uniqueSenders: { $size: '$uniqueSenders' },
        uniqueReceivers: { $size: '$uniqueReceivers' }
      }
    },
    { $sort: { totalAmount: -1 } }
  ]);
};

transactionSchema.statics.findFailedTransactions = function(options = {}) {
  const { limit = 50, skip = 0, retryable = true } = options;
  
  const query = { status: 'failed' };
  
  if (retryable) {
    query['retry.count'] = { $lt: '$retry.maxRetries' };
  }
  
  return this.find(query)
    .sort({ failedAt: -1 })
    .skip(skip)
    .limit(limit);
};

// 미들웨어
transactionSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  
  // 트랜잭션 ID 생성 (없는 경우)
  if (!this.transactionId) {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 10);
    this.transactionId = `tx_${timestamp}_${random}`.toUpperCase();
  }
  
  // 포맷된 금액 생성
  if (this.amount.value && !this.amount.formatted) {
    const amount = parseFloat(this.amount.value);
    const decimals = this.amount.decimals || 18;
    const formatted = (amount / Math.pow(10, decimals)).toFixed(6);
    this.amount.formatted = `${formatted} ${this.amount.currency}`;
  }
  
  next();
});

transactionSchema.post('save', function(doc, next) {
  // 대형 거래 또는 위험 거래에 대한 알림 (비동기)
  if (doc.isLargeTransaction || doc.security.riskScore > 70) {
    // 실제 구현에서는 알림 시스템 호출
    console.log(`High value/risk transaction detected: ${doc.transactionId}`);
  }
  
  next();
});

const Transaction = mongoose.model('Transaction', transactionSchema);

module.exports = Transaction;
