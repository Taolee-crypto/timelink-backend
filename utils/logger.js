const winston = require('winston');
const path = require('path');
const constants = require('../config/constants');

// 로그 레벨 색상
const colors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  http: 'magenta',
  debug: 'white',
};

winston.addColors(colors);

// 로그 포맷 설정
const format = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:ms' }),
  winston.format.colorize({ all: true }),
  winston.format.printf(
    (info) => `${info.timestamp} ${info.level}: ${info.message}`,
  ),
);

// 로그 전송 설정
const transports = [
  // 콘솔 출력
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    )
  }),
];

// 프로덕션 환경에서 파일 로그 추가
if (process.env.NODE_ENV === 'production') {
  transports.push(
    new winston.transports.File({
      filename: path.join(__dirname, '../../logs/error.log'),
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: path.join(__dirname, '../../logs/combined.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
  );
}

// 로거 생성
const logger = winston.createLogger({
  level: constants.MONITORING.LOG_LEVEL,
  format,
  transports,
});

// 커스텀 로그 메서드
class CustomLogger {
  // HTTP 요청 로그
  static http(req, res, responseTime) {
    const message = `${req.method} ${req.originalUrl} ${res.statusCode} ${responseTime}ms - ${req.ip}`;
    
    if (res.statusCode >= 400) {
      logger.warn(message);
    } else {
      logger.http(message);
    }
  }

  // 데이터베이스 쿼리 로그
  static query(operation, collection, query, duration) {
    logger.debug(`[DB] ${operation} ${collection} - ${duration}ms`, {
      operation,
      collection,
      query: JSON.stringify(query),
      duration
    });
  }

  // 비즈니스 로직 로그
  static business(module, action, data = {}) {
    logger.info(`[${module}] ${action}`, data);
  }

  // 에러 로그 (상세 정보 포함)
  static error(error, context = {}) {
    const errorInfo = {
      message: error.message,
      stack: error.stack,
      code: error.code,
      ...context
    };

    logger.error(JSON.stringify(errorInfo, null, 2));
  }

  // 성능 로그
  static performance(operation, startTime, metadata = {}) {
    const duration = Date.now() - startTime;
    const level = duration > 1000 ? 'warn' : 'info';
    
    logger.log(level, `[PERF] ${operation} - ${duration}ms`, metadata);
  }

  // 보안 관련 로그
  static security(event, user, details = {}) {
    logger.warn(`[SECURITY] ${event} - User: ${user}`, details);
  }

  // 파일 업로드 로그
  static upload(fileInfo, status, metadata = {}) {
    logger.info(`[UPLOAD] ${status} - ${fileInfo.originalName} (${fileInfo.size} bytes)`, metadata);
  }

  // 결제 로그
  static payment(transaction, status, details = {}) {
    logger.info(`[PAYMENT] ${status} - ${transaction.amount} TLT`, {
      transactionId: transaction.id,
      ...details
    });
  }

  // API 요청/응답 로그 (디버그용)
  static api(req, res, body = {}) {
    if (constants.MONITORING.LOG_LEVEL === 'debug') {
      logger.debug(`[API] ${req.method} ${req.path}`, {
        headers: req.headers,
        params: req.params,
        query: req.query,
        body: req.body,
        response: body
      });
    }
  }

  // 메모리 사용량 로그
  static memory() {
    const used = process.memoryUsage();
    logger.debug('[MEMORY]', {
      rss: `${Math.round(used.rss / 1024 / 1024)} MB`,
      heapTotal: `${Math.round(used.heapTotal / 1024 / 1024)} MB`,
      heapUsed: `${Math.round(used.heapUsed / 1024 / 1024)} MB`,
      external: `${Math.round(used.external / 1024 / 1024)} MB`,
    });
  }

  // 요청 ID를 이용한 로그 그룹화
  static withRequestId(requestId) {
    return {
      info: (message, data) => logger.info(`[${requestId}] ${message}`, data),
      error: (message, error) => logger.error(`[${requestId}] ${message}`, error),
      warn: (message, data) => logger.warn(`[${requestId}] ${message}`, data),
      debug: (message, data) => logger.debug(`[${requestId}] ${message}`, data),
    };
  }

  // 구조화된 로그 (JSON 형식)
  static structured(level, message, metadata = {}) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...metadata,
      environment: process.env.NODE_ENV,
      service: 'timelink-backend'
    };

    logger.log(level, JSON.stringify(logEntry));
  }
}

// 글로벌 예외 처리기
process.on('uncaughtException', (error) => {
  CustomLogger.error(error, { type: 'uncaughtException' });
  if (process.env.NODE_ENV === 'production') {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  CustomLogger.error(reason, { type: 'unhandledRejection', promise });
});

module.exports = CustomLogger;
