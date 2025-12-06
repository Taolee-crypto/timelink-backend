const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis');
const Redis = require('ioredis');
const constants = require('../config/constants');

// Redis 클라이언트 생성 (사용 가능한 경우)
let redisClient = null;
let redisStore = null;

try {
  if (process.env.REDIS_URL) {
    redisClient = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      }
    });

    redisClient.on('connect', () => {
      console.log('✅ Redis connected for rate limiting');
    });

    redisClient.on('error', (err) => {
      console.error('Redis connection error:', err);
      redisClient = null;
    });

    redisStore = new RedisStore({
      client: redisClient,
      prefix: 'ratelimit:timelink:'
    });
  }
} catch (error) {
  console.warn('Redis not available for rate limiting, using memory store');
}

// 기본 속도 제한 설정
const defaultLimiter = rateLimit({
  store: redisStore || undefined, // Redis 사용 가능하면 사용, 아니면 메모리
  windowMs: constants.SECURITY.RATE_LIMIT.WINDOW_MS,
  max: constants.SECURITY.RATE_LIMIT.MAX_REQUESTS,
  message: {
    error: 'Too many requests',
    code: constants.ERROR_CODES.RATE_LIMIT_EXCEEDED,
    message: 'Please try again later'
  },
  standardHeaders: true, // `RateLimit-*` 헤더 반환
  legacyHeaders: false, // `X-RateLimit-*` 헤더 비활성화
  keyGenerator: (req) => {
    // IP + 사용자 ID 조합으로 키 생성
    const ip = req.ip;
    const userId = req.user?.id || 'anonymous';
    return `${ip}:${userId}`;
  },
  skip: (req) => {
    // 특정 조건에서 속도 제한 스킵
    const skipPaths = ['/health', '/api/health'];
    if (skipPaths.includes(req.path)) return true;
    
    // 관리자는 속도 제한 제외
    if (req.user?.role === 'admin') return true;
    
    return false;
  },
  handler: (req, res, next, options) => {
    const resetTime = Math.ceil(options.windowMs / 1000);
    
    res.setHeader('Retry-After', resetTime);
    res.status(429).json(options.message);
  }
});

// API 엔드포인트별 속도 제한 설정
const rateLimiters = {
  // 기본 제한
  default: defaultLimiter,

  // 엄격한 제한 (로그인, 회원가입 등)
  strict: rateLimit({
    windowMs: 15 * 60 * 1000, // 15분
    max: 5, // 5번만 시도 가능
    message: {
      error: 'Too many attempts',
      message: 'Please wait 15 minutes before trying again'
    },
    skip: (req) => req.user?.role === 'admin'
  }),

  // 파일 업로드 제한
  upload: rateLimit({
    windowMs: 60 * 60 * 1000, // 1시간
    max: 20, // 시간당 20개 파일
    message: {
      error: 'Upload limit exceeded',
      message: 'You can upload up to 20 files per hour'
    },
    skip: (req) => req.user?.role === 'admin'
  }),

  // API 키 기반 제한 (높은 한도)
  apiKey: rateLimit({
    windowMs: 60 * 60 * 1000, // 1시간
    max: 1000, // 시간당 1000 요청
    keyGenerator: (req) => {
      const apiKey = req.headers['x-api-key'] || 'anonymous';
      return `api-key:${apiKey}`;
    }
  }),

  // IP 기반 제한 (엄격)
  byIp: rateLimit({
    windowMs: 60 * 60 * 1000, // 1시간
    max: 100,
    keyGenerator: (req) => req.ip
  }),

  // 웹소켓/실시간 연결 제한
  websocket: rateLimit({
    windowMs: 60 * 1000, // 1분
    max: 60, // 분당 60 연결
    keyGenerator: (req) => req.headers['sec-websocket-key'] || req.ip
  })
};

// 동적 속도 제한 미들웨어
const dynamicRateLimit = (options = {}) => {
  return (req, res, next) => {
    let limiterType = 'default';
    
    // 경로에 따른 제한기 선택
    if (req.path.startsWith('/api/auth')) {
      limiterType = 'strict';
    } else if (req.path.startsWith('/api/upload')) {
      limiterType = 'upload';
    } else if (req.headers['x-api-key']) {
      limiterType = 'apiKey';
    } else if (req.path.startsWith('/ws')) {
      limiterType = 'websocket';
    }
    
    // 사용자 역할에 따른 조정
    if (req.user?.role === 'creator') {
      // 크리에이터는 업로드 제한 증가
      if (limiterType === 'upload') {
        const creatorLimiter = rateLimit({
          ...rateLimiters.upload,
          max: 50 // 크리에이터는 시간당 50개
        });
        return creatorLimiter(req, res, next);
      }
    }
    
    // 선택된 제한기 적용
    const limiter = rateLimiters[limiterType] || rateLimiters.default;
    return limiter(req, res, next);
  };
};

// 사용자별 속도 제한 관리
const userRateLimitManager = {
  // 사용자 속도 제한 설정 가져오기
  getUserLimit: (userId) => {
    const defaultLimits = {
      requestsPerHour: 100,
      uploadsPerHour: 20,
      apiCallsPerMinute: 60
    };
    
    // 실제 구현에서는 DB에서 사용자별 제한 설정 조회
    return defaultLimits;
  },
  
  // 사용자 속도 제한 업데이트
  updateUserLimit: async (userId, newLimits) => {
    // 실제 구현에서는 DB에 저장
    console.log(`Updating rate limits for user ${userId}:`, newLimits);
    return true;
  },
  
  // 사용자 요청 수 확인
  checkUserRequestCount: async (userId, window = 'hour') => {
    if (!redisClient) {
      // Redis 없으면 간단한 검사
      return { count: 0, limit: 100 };
    }
    
    try {
      const key = `user:requests:${userId}:${window}`;
      const count = await redisClient.get(key) || 0;
      const limit = this.getUserLimit(userId).requestsPerHour;
      
      return {
        count: parseInt(count),
        limit,
        remaining: Math.max(0, limit - parseInt(count))
      };
    } catch (error) {
      console.error('Error checking user request count:', error);
      return { count: 0, limit: 100, remaining: 100 };
    }
  },
  
  // 사용자 요청 증가
  incrementUserRequest: async (userId, window = 'hour') => {
    if (!redisClient) return;
    
    try {
      const key = `user:requests:${userId}:${window}`;
      const windowMs = window === 'hour' ? 3600000 : 60000;
      
      await redisClient.multi()
        .incr(key)
        .pexpire(key, windowMs)
        .exec();
    } catch (error) {
      console.error('Error incrementing user request:', error);
    }
  }
};

// 속도 제한 상태 모니터링
const rateLimitMonitor = {
  getStatus: async () => {
    const status = {
      redis: !!redisClient,
      defaultWindow: constants.SECURITY.RATE_LIMIT.WINDOW_MS,
      defaultMax: constants.SECURITY.RATE_LIMIT.MAX_REQUESTS,
      timestamp: new Date()
    };
    
    if (redisClient) {
      try {
        const info = await redisClient.info();
        status.redisInfo = {
          connected: true,
          version: info.match(/redis_version:(.+)/)?.[1],
          memory: info.match(/used_memory_human:(.+)/)?.[1]
        };
      } catch (error) {
        status.redisInfo = { connected: false, error: error.message };
      }
    }
    
    return status;
  },
  
  // 속도 제한 통계
  getStats: async (period = 'day') => {
    if (!redisClient) {
      return { message: 'Redis not available for statistics' };
    }
    
    try {
      // Redis에서 속도 제한 관련 키들 조회
      const pattern = 'ratelimit:timelink:*';
      const keys = await redisClient.keys(pattern);
      
      const stats = {
        totalKeys: keys.length,
        period,
        timestamp: new Date()
      };
      
      return stats;
    } catch (error) {
      console.error('Error getting rate limit stats:', error);
      return { error: error.message };
    }
  }
};

module.exports = {
  rateLimiters,
  dynamicRateLimit,
  userRateLimitManager,
  rateLimitMonitor,
  // 기본 내보내기
  default: dynamicRateLimit
};
