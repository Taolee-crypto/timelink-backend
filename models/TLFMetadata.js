const mongoose = require('mongoose');

const tlfMetadataSchema = new mongoose.Schema({
  // TLF 기본 정보
  tlfId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  
  // 파일 해시 정보
  hashes: {
    file: {
      type: String,
      required: true,
      index: true
    },
    metadata: {
      type: String,
      required: true
    },
    tlf: {
      type: String,
      required: true
    },
    algorithm: {
      type: String,
      default: 'sha256'
    }
  },
  
  // 파일 메타데이터
  fileInfo: {
    type: {
      type: String,
      enum: ['video', 'audio', 'image', 'document'],
      required: true
    },
    format: String,
    size: Number, // bytes
    duration: Number, // seconds (미디어 파일)
    dimensions: {
      width: Number, // pixels
      height: Number // pixels
    },
    bitrate: Number, // kbps (미디어 파일)
    codec: String,
    sampleRate: Number, // Hz (오디오)
    channels: Number, // 오디오 채널 수
    pages: Number, // 문서 페이지 수
    resolution: String // 이미지/비디오 해상도
  },
  
  // 콘텐츠 메타데이터
  content: {
    title: {
      type: String,
      required: true,
      index: 'text'
    },
    description: String,
    tags: [String],
    category: String,
    language: String,
    subtitles: [{
      language: String,
      format: String,
      url: String
    }],
    chapters: [{
      title: String,
      startTime: Number, // seconds
      endTime: Number // seconds
    }],
    rating: {
      average: {
        type: Number,
        min: 0,
        max: 5,
        default: 0
      },
      count: {
        type: Number,
        default: 0
      }
    }
  },
  
  // 저작권 및 소유권 정보
  ownership: {
    creator: {
      address: {
        type: String,
        required: true,
        index: true
      },
      name: String,
      verified: {
        type: Boolean,
        default: false
      }
    },
    createdAt: {
      type: Date,
      default: Date.now
    },
    previousOwners: [{
      address: String,
      from: Date,
      to: Date,
      transaction: String
    }],
    rights: {
      commercialUse: {
        type: Boolean,
        default: false
      },
      modificationsAllowed: {
        type: Boolean,
        default: false
      },
      redistributionAllowed: {
        type: Boolean,
        default: false
      },
      licenseType: String
    }
  },
  
  // 가격 및 결제 정보
  pricing: {
    pricePerMinute: {
      type: Number,
      min: 0,
      default: 0
    },
    currency: {
      type: String,
      default: 'TLT'
    },
    isFree: {
      type: Boolean,
      default: false
    },
    discount: {
      percentage: Number,
      validUntil: Date
    },
    tieredPricing: [{
      duration: Number, // minutes
      price: Number
    }],
    rental: {
      enabled: Boolean,
      price: Number,
      duration: Number // hours
    }
  },
  
  // 접근 제어
  accessControl: {
    public: {
      type: Boolean,
      default: true
    },
    requiresPayment: {
      type: Boolean,
      default: false
    },
    allowedAddresses: [String],
    blockedAddresses: [String],
    maxPlays: Number,
    maxPlaysPerUser: Number,
    expiryDate: Date,
    geographicRestrictions: [String], // 국가 코드
    ageRestriction: {
      type: Number,
      min: 0,
      max: 100
    }
  },
  
  // 스마트 컨트랙트 정보
  contractInfo: {
    contractAddress: String,
    tokenId: String, // NFT인 경우
    chainId: Number,
    network: String,
    deploymentBlock: Number,
    deploymentTx: String,
    lastUpdatedBlock: Number
  },
  
  // 저장 및 분배 정보
  storage: {
    locations: [{
      provider: String, // 'cloudflare', 'ipfs', 'arweave'
      url: String,
      cid: String, // IPFS CID
      pinStatus: String,
      lastVerified: Date
    }],
    primaryLocation: String,
    redundancy: {
      type: Number,
      min: 1,
      max: 10,
      default: 3
    },
    encryption: {
      enabled: Boolean,
      algorithm: String,
      keyHash: String
    }
  },
  
  // 로열티 및 수익 분배
  royalties: [{
    recipient: String,
    percentage: {
      type: Number,
      min: 0,
      max: 100
    },
    description: String
  }],
  
  // 통계 및 분석
  analytics: {
    totalPlays: {
      type: Number,
      default: 0
    },
    totalEarnings: {
      type: Number,
      default: 0
    },
    uniqueViewers: {
      type: Number,
      default: 0
    },
    avgWatchTime: Number,
    completionRate: Number, // percentage
    peakConcurrent: {
      type: Number,
      default: 0
    },
    lastPlayed: Date,
    trendingScore: Number // 트렌딩 알고리즘 점수
  },
  
  // 버전 관리
  version: {
    current: {
      type: String,
      default: '1.0.0'
    },
    history: [{
      version: String,
      changes: String,
      updatedAt: Date,
      updatedBy: String
    }],
    isLatest: {
      type: Boolean,
      default: true
    }
  },
  
  // 검증 정보
  verification: {
    verified: {
      type: Boolean,
      default: false
    },
    verifiedBy: String,
    verifiedAt: Date,
    verificationMethod: String,
    trustScore: {
      type: Number,
      min: 0,
      max: 100,
      default: 0
    }
  },
  
  // 메타데이터
  metadata: mongoose.Schema.Types.Mixed,
  
  // 시스템 정보
  system: {
    createdBy: {
      type: String,
      default: 'system'
    },
    source: String, // 업로드 방법
    processingTime: Number, // milliseconds
    indexedAt: {
      type: Date,
      default: Date.now,
      index: true
    }
  },
  
  // 상태 정보
  status: {
    type: String,
    enum: ['draft', 'processing', 'active', 'suspended', 'archived', 'deleted'],
    default: 'processing',
    index: true
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
  publishedAt: Date,
  archivedAt: Date
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// 인덱스 설정
tlfMetadataSchema.index({ 'content.title': 'text', 'content.description': 'text', 'content.tags': 'text' });
tlfMetadataSchema.index({ 'ownership.creator.address': 1, createdAt: -1 });
tlfMetadataSchema.index({ 'pricing.pricePerMinute': 1 });
tlfMetadataSchema.index({ 'analytics.totalPlays': -1 });
tlfMetadataSchema.index({ 'analytics.trendingScore': -1 });
tlfMetadataSchema.index({ 'fileInfo.type': 1 });
tlfMetadataSchema.index({ 'content.category': 1 });
tlfMetadataSchema.index({ status: 1, 'system.indexedAt': -1 });

// 가상 필드
tlfMetadataSchema.virtual('estimatedEarnings').get(function() {
  const minutes = this.analytics.avgWatchTime ? this.analytics.avgWatchTime / 60 : 0;
  return minutes * this.pricing.pricePerMinute * this.analytics.totalPlays;
});

tlfMetadataSchema.virtual('earningsPerPlay').get(function() {
  if (this.analytics.totalPlays === 0) return 0;
  return this.analytics.totalEarnings / this.analytics.totalPlays;
});

// 메서드
tlfMetadataSchema.methods.updateAnalytics = function(playData) {
  this.analytics.totalPlays += 1;
  
  if (playData.duration) {
    const totalWatchTime = (this.analytics.avgWatchTime || 0) * (this.analytics.totalPlays - 1);
    this.analytics.avgWatchTime = (totalWatchTime + playData.duration) / this.analytics.totalPlays;
  }
  
  if (playData.amount) {
    this.analytics.totalEarnings += playData.amount;
  }
  
  this.analytics.lastPlayed = new Date();
  
  // 트렌딩 점수 업데이트 (가중치: 재생 수, 수익, 최근 활동)
  const recencyWeight = 1 / (1 + (Date.now() - this.createdAt) / (7 * 24 * 60 * 60 * 1000)); // 1주일 기준
  this.analytics.trendingScore = 
    (this.analytics.totalPlays * 0.4) + 
    (this.analytics.totalEarnings * 0.3) + 
    (recencyWeight * 0.3);
  
  return this;
};

tlfMetadataSchema.methods.addViewer = function(address) {
  // 실제 구현에서는 중복 제거 로직 필요
  return this;
};

// 정적 메서드
tlfMetadataSchema.statics.findByCreator = function(creatorAddress, options = {}) {
  const { status, limit = 20, skip = 0, sortBy = 'createdAt', sortOrder = 'desc' } = options;
  
  const query = { 'ownership.creator.address': creatorAddress.toLowerCase() };
  if (status) query.status = status;
  
  const sort = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };
  
  return this.find(query)
    .sort(sort)
    .skip(skip)
    .limit(limit);
};

tlfMetadataSchema.statics.search = function(searchTerm, filters = {}) {
  const query = {
    $text: { $search: searchTerm },
    status: 'active'
  };
  
  // 필터 적용
  if (filters.type) query['fileInfo.type'] = filters.type;
  if (filters.category) query['content.category'] = filters.category;
  if (filters.minPrice !== undefined) query['pricing.pricePerMinute'] = { $gte: filters.minPrice };
  if (filters.maxPrice !== undefined) {
    query['pricing.pricePerMinute'] = query['pricing.pricePerMinute'] || {};
    query['pricing.pricePerMinute'].$lte = filters.maxPrice;
  }
  if (filters.isFree !== undefined) query['pricing.isFree'] = filters.isFree;
  
  return this.find(query)
    .sort({ score: { $meta: 'textScore' } })
    .select({ score: { $meta: 'textScore' } });
};

tlfMetadataSchema.statics.getTrending = function(limit = 10, timeRange = 'day') {
  const timeAgo = new Date();
  
  switch (timeRange) {
    case 'hour':
      timeAgo.setHours(timeAgo.getHours() - 1);
      break;
    case 'day':
      timeAgo.setDate(timeAgo.getDate() - 1);
      break;
    case 'week':
      timeAgo.setDate(timeAgo.getDate() - 7);
      break;
    case 'month':
      timeAgo.setMonth(timeAgo.getMonth() - 1);
      break;
    default:
      timeAgo.setDate(timeAgo.getDate() - 1);
  }
  
  return this.aggregate([
    {
      $match: {
        status: 'active',
        createdAt: { $gte: timeAgo }
      }
    },
    {
      $addFields: {
        trendingScore: {
          $add: [
            { $multiply: ['$analytics.totalPlays', 0.4] },
            { $multiply: ['$analytics.totalEarnings', 0.3] },
            { 
              $multiply: [
                { 
                  $divide: [
                    1,
                    { $add: [1, { $divide: [{ $subtract: [new Date(), '$createdAt'] }, 604800000] }] } // 7일 기준
                  ]
                },
                0.3
              ]
            }
          ]
        }
      }
    },
    { $sort: { trendingScore: -1 } },
    { $limit: limit }
  ]);
};

// 미들웨어
tlfMetadataSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  
  // 해시 계산 (간소화된 버전)
  if (this.isModified('fileInfo') || this.isModified('content') || this.isModified('ownership')) {
    const hashData = {
      fileInfo: this.fileInfo,
      content: this.content,
      ownership: this.ownership
    };
    // 실제 구현에서는 해시 계산 로직 추가
  }
  
  next();
});

const TLFMetadata = mongoose.model('TLFMetadata', tlfMetadataSchema);

module.exports = TLFMetadata;
