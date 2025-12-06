module.exports = {
  // TimeLink 플랫폼 상수
  PLATFORM: {
    NAME: 'TimeLink',
    VERSION: '1.0.0',
    TLT_DECIMALS: 18,
    TLT_SYMBOL: 'TLT'
  },

  // TLF (TimeLink File) 설정
  TLF: {
    VERSION: 'TLFv1',
    TYPES: ['video', 'audio', 'image', 'document'],
    MAX_FILE_SIZE: 500 * 1024 * 1024, // 500MB
    SUPPORTED_FORMATS: {
      video: ['mp4', 'mov', 'avi', 'mkv'],
      audio: ['mp3', 'wav', 'flac', 'm4a'],
      image: ['jpg', 'jpeg', 'png', 'gif'],
      document: ['pdf', 'txt', 'md']
    }
  },

  // 포인트 시스템
  POINTS: {
    UPLOAD_REWARD: 100,
    VIEW_REWARD: 10,
    REFERRAL_REWARD: 50,
    DAILY_CHECKIN: 5
  },

  // 가격 설정
  PRICING: {
    MIN_PRICE_PER_MINUTE: 0.01, // 최소 분당 가격 (TLT)
    MAX_PRICE_PER_MINUTE: 100,  // 최대 분당 가격 (TLT)
    PLATFORM_FEE_PERCENT: 5     // 플랫폼 수수료 (%)
  }
};
