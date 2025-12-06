const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  // 지갑 정보
  walletAddress: {
    type: String,
    required: true,
    unique: true,
    lowercase: true
  },
  
  // 사용자 정보
  username: {
    type: String,
    unique: true,
    sparse: true
  },
  email: {
    type: String,
    unique: true,
    sparse: true
  },
  avatarUrl: String,
  bio: String,
  
  // 플랫폼 통계
  totalEarned: {
    type: Number,
    default: 0
  },
  totalSpent: {
    type: Number,
    default: 0
  },
  uploadedFiles: {
    type: Number,
    default: 0
  },
  totalViews: {
    type: Number,
    default: 0
  },
  
  // 포인트 시스템
  points: {
    type: Number,
    default: 0
  },
  referralCode: {
    type: String,
    unique: true,
    sparse: true
  },
  referredBy: String,
  
  // 계정 상태
  isVerified: {
    type: Boolean,
    default: false
  },
  isBanned: {
    type: Boolean,
    default: false
  },
  role: {
    type: String,
    enum: ['user', 'creator', 'admin'],
    default: 'user'
  },
  
  // 설정
  notifications: {
    email: { type: Boolean, default: true },
    earnings: { type: Boolean, default: true },
    newContent: { type: Boolean, default: true }
  },
  
  // 시간 정보
  createdAt: {
    type: Date,
    default: Date.now
  },
  lastLogin: Date,
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// 인덱스
userSchema.index({ walletAddress: 1 });
userSchema.index({ username: 1 });
userSchema.index({ totalEarned: -1 });
userSchema.index({ points: -1 });

module.exports = mongoose.model('User', userSchema);
