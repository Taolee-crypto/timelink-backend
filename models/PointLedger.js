const mongoose = require('mongoose');

const pointLedgerSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  userAddress: String,
  
  // 포인트 트랜잭션
  transactionType: {
    type: String,
    enum: [
      'upload_reward',      // 업로드 보상
      'view_reward',        // 시청 보상  
      'purchase_spent',     // 구매 지출
      'sale_earned',        // 판매 수익
      'referral_bonus',     // 추천 보너스
      'daily_checkin',      // 출석 체크
      'admin_grant',        // 관리자 지급
      'withdrawal'          // 인출
    ],
    required: true
  },
  
  points: {
    type: Number,
    required: true
  },
  
  // 관련 콘텐츠/거래
  relatedFileId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'File'
  },
  relatedPlayId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Play'
  },
  relatedTransactionId: String,
  
  // 잔액 정보
  balanceBefore: Number,
  balanceAfter: Number,
  
  // 메타데이터
  description: String,
  metadata: mongoose.Schema.Types.Mixed,
  
  // 시간 정보
  createdAt: {
    type: Date,
    default: Date.now
  },
  expiresAt: Date // 포인트 만료일
});

// 인덱스
pointLedgerSchema.index({ userId: 1, createdAt: -1 });
pointLedgerSchema.index({ transactionType: 1 });
pointLedgerSchema.index({ userAddress: 1 });

module.exports = mongoose.model('PointLedger', pointLedgerSchema);
