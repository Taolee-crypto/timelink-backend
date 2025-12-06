const mongoose = require('mongoose');

const playSchema = new mongoose.Schema({
  // 콘텐츠 참조
  file: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'File',
    required: true,
    index: true
  },
  
  // TLF 정보
  tlfId: {
    type: String,
    index: true
  },
  
  // 시청자 정보
  viewer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },
  viewerAddress: {
    type: String,
    required: true,
    index: true
  },
  
  // 재생 세션 정보
  sessionId: {
    type: String,
    unique: true,
    sparse: true
  },
  
  // 재생 시간 정보
  startedAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  endedAt: Date,
  duration: {
    type: Number, // seconds
    min: 0
  },
  
  // 재생 위치 추적
  positions: [{
    timestamp: Date,
    position: Number, // seconds
    event: {
      type: String,
      enum: ['play', 'pause', 'seek', 'buffer']
    }
  }],
  
  currentPosition: {
    type: Number, // seconds
    default: 0
  },
  maxPositionReached: {
    type: Number, // seconds
    default: 0
  },
  
  // 재생 상태
  status: {
    type: String,
    enum: ['initiated', 'playing', 'paused', 'buffering', 'completed', 'abandoned', 'error'],
    default: 'initiated',
    index: true
  },
  
  // 완료 정보
  completionPercentage: {
    type: Number, // 0-100
    min: 0,
    max: 100,
    default: 0
  },
  isCompleted: {
    type: Boolean,
    default: false,
    index: true
  },
  
  // 결제 정보
  pricing: {
    pricePerMinute: Number,
    currency: {
      type: String,
      default: 'TLT'
    },
    isFree: {
      type: Boolean,
      default: false
    }
  },
  
  payment: {
    amount: Number,
    status: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'failed', 'refunded'],
      default: 'pending'
    },
    transactionHash: String,
    paymentMethod: {
      type: String,
      enum: ['crypto', 'points', 'free', 'promotional'],
      default: 'crypto'
    },
    paidAt: Date,
    fee: {
      platform: Number,
      network: Number
    }
  },
  
  // 포인트 정보
  points: {
    earned: {
      type: Number,
      default: 0
    },
    multiplier: {
      type: Number,
      default: 1.0
    }
  },
  
  // 기기 및 네트워크 정보
  device: {
    type: {
      type: String,
      enum: ['desktop', 'mobile', 'tablet', 'tv', 'unknown']
    },
    os: String,
    browser: String,
    userAgent: String
  },
  
  network: {
    ipAddress: String,
    country: String,
    region: String,
    city: String,
    isp: String,
    bandwidth: String // 예: 'broadband', 'mobile', 'satellite'
  },
  
  // 품질 정보
  quality: {
    requested: String, // 예: '360p', '720p', '1080p'
    delivered: String,
    bitrate: Number, // kbps
    bufferHealth: Number // seconds
  },
  
  // 에러 정보
  error: {
    code: String,
    message: String,
    details: mongoose.Schema.Types.Mixed,
    occurredAt: Date
  },
  
  // 메타데이터
  metadata: mongoose.Schema.Types.Mixed,
  
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
  
  // 만료 정보 (임시 세션 등)
  expiresAt: {
    type: Date,
    index: true,
    expires: 0 // TTL 인덱스
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// 인덱스 설정
playSchema.index({ viewerAddress: 1, startedAt: -1 });
playSchema.index({ file: 1, startedAt: -1 });
playSchema.index({ status: 1, updatedAt: -1 });
playSchema.index({ 'payment.status': 1 });
playSchema.index({ isCompleted: 1, endedAt: -1 });
playSchema.index({ tlfId: 1, viewerAddress: 1 }, { unique: true, sparse: true });

// 가상 필드
playSchema.virtual('playbackTime').get(function() {
  if (this.endedAt && this.startedAt) {
    return (this.endedAt - this.startedAt) / 1000; // 초 단위
  }
  return null;
});

playSchema.virtual('cost').get(function() {
  if (this.pricing.isFree) return 0;
  
  const minutes = this.duration ? this.duration / 60 : 0;
  return minutes * (this.pricing.pricePerMinute || 0);
});

// 메서드
playSchema.methods.updatePosition = function(position, event = 'play') {
  this.currentPosition = position;
  this.maxPositionReached = Math.max(this.maxPositionReached, position);
  
  this.positions.push({
    timestamp: new Date(),
    position,
    event
  });
  
  // 위치가 95% 이상이면 완료로 간주
  const fileDuration = this.file?.duration || 0;
  if (fileDuration > 0) {
    this.completionPercentage = (position / fileDuration) * 100;
    if (this.completionPercentage >= 95) {
      this.isCompleted = true;
      this.status = 'completed';
    }
  }
  
  return this;
};

playSchema.methods.complete = function() {
  this.endedAt = new Date();
  this.duration = (this.endedAt - this.startedAt) / 1000;
  this.status = 'completed';
  this.isCompleted = true;
  this.completionPercentage = 100;
  
  return this;
};

playSchema.methods.abandon = function(reason) {
  this.endedAt = new Date();
  this.status = 'abandoned';
  this.error = {
    message: reason || 'Playback abandoned',
    occurredAt: new Date()
  };
  
  return this;
};

// 정적 메서드
playSchema.statics.findActiveSessions = function(userId) {
  return this.find({
    viewer: userId,
    status: { $in: ['playing', 'paused', 'buffering'] },
    expiresAt: { $gt: new Date() }
  }).populate('file', 'title thumbnailUrl duration');
};

playSchema.statics.getUserPlayHistory = function(userId, options = {}) {
  const { limit = 20, skip = 0, fileId, status } = options;
  
  const query = { viewer: userId };
  if (fileId) query.file = fileId;
  if (status) query.status = status;
  
  return this.find(query)
    .sort({ startedAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate('file', 'title thumbnailUrl fileType duration');
};

playSchema.statics.getFilePlayStats = function(fileId) {
  return this.aggregate([
    { $match: { file: mongoose.Types.ObjectId.createFromHexString(fileId) } },
    {
      $group: {
        _id: '$file',
        totalPlays: { $sum: 1 },
        completedPlays: { 
          $sum: { $cond: [{ $eq: ['$isCompleted', true] }, 1, 0] }
        },
        totalDuration: { $sum: '$duration' },
        avgCompletion: { $avg: '$completionPercentage' },
        uniqueViewers: { $addToSet: '$viewerAddress' },
        totalRevenue: { $sum: '$payment.amount' },
        avgWatchTime: { $avg: '$duration' }
      }
    },
    {
      $project: {
        totalPlays: 1,
        completedPlays: 1,
        totalDuration: 1,
        avgCompletion: 1,
        uniqueViewers: { $size: '$uniqueViewers' },
        totalRevenue: 1,
        avgWatchTime: 1
      }
    }
  ]);
};

// 미들웨어
playSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  
  // 완료된 재생은 30일 후 삭제되도록 만료 설정
  if (this.status === 'completed' || this.status === 'abandoned') {
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    this.expiresAt = new Date(Date.now() + thirtyDays);
  }
  
  next();
});

const Play = mongoose.model('Play', playSchema);

module.exports = Play;
