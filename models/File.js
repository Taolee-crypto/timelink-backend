const mongoose = require('mongoose');

const fileSchema = new mongoose.Schema({
  // 기본 정보
  filename: {
    type: String,
    required: true
  },
  originalName: String,
  fileType: {
    type: String,
    enum: ['video', 'audio', 'image', 'document'],
    required: true
  },
  fileSize: Number, // bytes
  duration: Number, // seconds (미디어 파일일 경우)
  
  // TLF 정보
  tlfId: {
    type: String,
    unique: true,
    sparse: true
  },
  tlfHash: String,
  
  // 저장 정보
  storageUrl: String, // Cloudflare R2 URL
  thumbnailUrl: String,
  
  // 메타데이터
  title: String,
  description: String,
  tags: [String],
  category: String,
  
  // 가격 정보
  pricePerMinute: {
    type: Number,
    default: 0.1,
    min: 0.01
  },
  isFree: {
    type: Boolean,
    default: false
  },
  
  // 소유권
  creatorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  creatorAddress: String, // 블록체인 주소
  
  // 통계
  viewCount: {
    type: Number,
    default: 0
  },
  totalEarned: {
    type: Number,
    default: 0
  },
  averageWatchTime: Number,
  
  // 상태
  status: {
    type: String,
    enum: ['processing', 'ready', 'published', 'hidden', 'blocked'],
    default: 'processing'
  },
  
  // 시간 정보
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  },
  publishedAt: Date
});

// 인덱스 설정
fileSchema.index({ tlfId: 1 });
fileSchema.index({ creatorId: 1 });
fileSchema.index({ status: 1, createdAt: -1 });
fileSchema.index({ tags: 1 });
fileSchema.index({ 'pricePerMinute': 1 });

module.exports = mongoose.model('File', fileSchema);
