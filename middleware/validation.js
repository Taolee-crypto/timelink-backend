const { body, param, query, validationResult } = require('express-validator');
const constants = require('../config/constants');

const validationMiddleware = {
  // 공통 검증 결과 처리
  handleValidation: (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Validation failed',
        code: constants.ERROR_CODES.VALIDATION_ERROR,
        details: errors.array()
      });
    }
    next();
  },

  // 파일 업로드 검증
  validateUpload: [
    body('title')
      .notEmpty().withMessage('Title is required')
      .isLength({ min: 3, max: 200 }).withMessage('Title must be 3-200 characters'),
    body('description')
      .optional()
      .isLength({ max: 1000 }).withMessage('Description too long'),
    body('pricePerMinute')
      .optional()
      .isFloat({ 
        min: constants.PRICING.MIN_PRICE_PER_MINUTE, 
        max: constants.PRICING.MAX_PRICE_PER_MINUTE 
      }).withMessage(`Price must be between ${constants.PRICING.MIN_PRICE_PER_MINUTE} and ${constants.PRICING.MAX_PRICE_PER_MINUTE} TLT`),
    body('isFree')
      .optional()
      .isBoolean().withMessage('isFree must be boolean'),
    body('tags')
      .optional()
      .isArray().withMessage('Tags must be an array'),
    body('category')
      .optional()
      .isString().withMessage('Category must be string')
  ],

  // 지갑 연결 검증
  validateWalletConnect: [
    body('walletAddress')
      .notEmpty().withMessage('Wallet address is required')
      .matches(/^0x[a-fA-F0-9]{40}$/).withMessage('Invalid Ethereum address'),
    body('signature')
      .notEmpty().withMessage('Signature is required')
      .matches(/^0x[a-fA-F0-9]{130}$/).withMessage('Invalid signature format'),
    body('message')
      .notEmpty().withMessage('Message is required')
      .isString().withMessage('Message must be string')
  ],

  // 결제 검증
  validatePayment: [
    body('amount')
      .notEmpty().withMessage('Amount is required')
      .isFloat({ min: 0.01 }).withMessage('Amount must be at least 0.01'),
    body('fileId')
      .notEmpty().withMessage('File ID is required')
      .isMongoId().withMessage('Invalid file ID'),
    body('sessionId')
      .optional()
      .isMongoId().withMessage('Invalid session ID')
  ],

  // TLF 생성 검증
  validateTLFCreation: [
    param('fileId')
      .notEmpty().withMessage('File ID is required')
      .isMongoId().withMessage('Invalid file ID')
  ],

  // TLF 소유권 이전 검증
  validateTLFTransfer: [
    param('tlfId')
      .notEmpty().withMessage('TLF ID is required')
      .isString().withMessage('TLF ID must be string'),
    body('newOwnerAddress')
      .notEmpty().withMessage('New owner address is required')
      .matches(/^0x[a-fA-F0-9]{40}$/).withMessage('Invalid Ethereum address')
  ],

  // 가격 업데이트 검증
  validatePriceUpdate: [
    param('tlfId')
      .notEmpty().withMessage('TLF ID is required')
      .isString().withMessage('TLF ID must be string'),
    body('pricePerMinute')
      .notEmpty().withMessage('Price is required')
      .isFloat({ 
        min: constants.PRICING.MIN_PRICE_PER_MINUTE, 
        max: constants.PRICING.MAX_PRICE_PER_MINUTE 
      }).withMessage(`Price must be between ${constants.PRICING.MIN_PRICE_PER_MINUTE} and ${constants.PRICING.MAX_PRICE_PER_MINUTE} TLT`)
  ],

  // 사용자 생성/업데이트 검증
  validateUser: [
    body('username')
      .optional()
      .isLength({ min: 3, max: 30 }).withMessage('Username must be 3-30 characters')
      .matches(/^[a-zA-Z0-9_]+$/).withMessage('Username can only contain letters, numbers and underscores'),
    body('email')
      .optional()
      .isEmail().withMessage('Invalid email address')
      .normalizeEmail(),
    body('bio')
      .optional()
      .isLength({ max: 500 }).withMessage('Bio too long'),
    body('avatarUrl')
      .optional()
      .isURL().withMessage('Invalid avatar URL')
  ],

  // 검색 및 필터링 검증
  validateSearch: [
    query('page')
      .optional()
      .isInt({ min: 1 }).withMessage('Page must be positive integer')
      .toInt(),
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 }).withMessage('Limit must be 1-100')
      .toInt(),
    query('sortBy')
      .optional()
      .isIn(['createdAt', 'updatedAt', 'title', 'pricePerMinute', 'viewCount', 'totalEarned'])
      .withMessage('Invalid sort field'),
    query('sortOrder')
      .optional()
      .isIn(['asc', 'desc']).withMessage('Sort order must be asc or desc'),
    query('search')
      .optional()
      .isString().withMessage('Search term must be string')
      .trim()
      .escape(),
    query('minPrice')
      .optional()
      .isFloat({ min: 0 }).withMessage('Minimum price must be positive')
      .toFloat(),
    query('maxPrice')
      .optional()
      .isFloat({ min: 0 }).withMessage('Maximum price must be positive')
      .toFloat(),
    query('category')
      .optional()
      .isString().withMessage('Category must be string')
      .trim()
      .escape()
  ],

  // 파일 타입 검증
  validateFileType: (req, res, next) => {
    if (!req.file) {
      return next();
    }

    const allowedTypes = Object.values(constants.TLF.SUPPORTED_FORMATS).flat();
    const fileExtension = req.file.originalname.split('.').pop().toLowerCase();
    
    if (!allowedTypes.includes(fileExtension)) {
      return res.status(400).json({
        error: 'Invalid file type',
        code: constants.ERROR_CODES.INVALID_FILE_TYPE,
        allowedTypes,
        received: fileExtension
      });
    }

    // 파일 크기 검증
    if (req.file.size > constants.TLF.MAX_FILE_SIZE) {
      return res.status(400).json({
        error: 'File too large',
        code: constants.ERROR_CODES.FILE_TOO_LARGE,
        maxSize: `${constants.TLF.MAX_FILE_SIZE / (1024 * 1024)} MB`,
        received: `${(req.file.size / (1024 * 1024)).toFixed(2)} MB`
      });
    }

    next();
  },

  // MongoDB ID 검증
  validateMongoId: (paramName) => [
    param(paramName)
      .notEmpty().withMessage(`${paramName} is required`)
      .isMongoId().withMessage(`Invalid ${paramName}`)
  ],

  // 숫자 범위 검증
  validateNumberRange: (field, min, max) => [
    body(field)
      .optional()
      .isFloat({ min, max })
      .withMessage(`${field} must be between ${min} and ${max}`)
  ],

  // 배열 검증
  validateArray: (field, options = {}) => {
    const validators = [
      body(field)
        .optional()
        .isArray().withMessage(`${field} must be an array`)
    ];

    if (options.maxLength) {
      validators.push(
        body(field)
          .optional()
          .isArray({ max: options.maxLength })
          .withMessage(`${field} cannot have more than ${options.maxLength} items`)
      );
    }

    if (options.itemType === 'string') {
      validators.push(
        body(`${field}.*`)
          .optional()
          .isString().withMessage(`Items in ${field} must be strings`)
      );
    }

    return validators;
  },

  // 날짜 범위 검증
  validateDateRange: [
    query('startDate')
      .optional()
      .isISO8601().withMessage('startDate must be ISO8601 date')
      .toDate(),
    query('endDate')
      .optional()
      .isISO8601().withMessage('endDate must be ISO8601 date')
      .toDate()
      .custom((value, { req }) => {
        if (req.query.startDate && value < req.query.startDate) {
          throw new Error('endDate must be after startDate');
        }
        return true;
      })
  ],

  // 파일 상태 검증
  validateFileStatus: [
    query('status')
      .optional()
      .isIn(constants.TLF.PROCESSING_STAGES)
      .withMessage('Invalid status value')
  ],

  // 사용자 역할 검증
  validateUserRole: [
    body('role')
      .optional()
      .isIn(['user', 'creator', 'admin'])
      .withMessage('Invalid user role')
  ],

  // 이메일 형식 검증
  validateEmail: (field = 'email') => [
    body(field)
      .optional()
      .isEmail().withMessage('Invalid email address')
      .normalizeEmail()
  ],

  // URL 검증
  validateURL: (field) => [
    body(field)
      .optional()
      .isURL().withMessage(`Invalid URL for ${field}`)
      .trim()
  ],

  // 비밀번호 강도 검증
  validatePassword: [
    body('password')
      .notEmpty().withMessage('Password is required')
      .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
      .matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter')
      .matches(/[a-z]/).withMessage('Password must contain at least one lowercase letter')
      .matches(/\d/).withMessage('Password must contain at least one number')
      .matches(/[!@#$%^&*(),.?":{}|<>]/).withMessage('Password must contain at least one special character')
  ],

  // 커스텀 검증: 파일 가격
  validateFilePricing: (req, res, next) => {
    const { pricePerMinute, isFree } = req.body;
    
    if (isFree && pricePerMinute && pricePerMinute > 0) {
      return res.status(400).json({
        error: 'Free files cannot have a price',
        code: constants.ERROR_CODES.VALIDATION_ERROR
      });
    }

    next();
  },

  // 커스텀 검증: 파일 지속 시간
  validateFileDuration: (req, res, next) => {
    const { duration } = req.body;
    
    if (duration && duration > constants.TLF.MAX_DURATION) {
      return res.status(400).json({
        error: `Duration cannot exceed ${constants.TLF.MAX_DURATION / 3600} hours`,
        code: constants.ERROR_CODES.VALIDATION_ERROR,
        maxDuration: constants.TLF.MAX_DURATION,
        received: duration
      });
    }

    next();
  },

  // 요청 본문 크기 검증 미들웨어
  validateBodySize: (maxSize = '10mb') => {
    return (req, res, next) => {
      const contentLength = parseInt(req.headers['content-length']);
      
      if (contentLength) {
        const maxBytes = this.parseSize(maxSize);
        
        if (contentLength > maxBytes) {
          return res.status(413).json({
            error: 'Request body too large',
            maxSize,
            received: `${(contentLength / 1024 / 1024).toFixed(2)} MB`
          });
        }
      }
      
      next();
    };
  },

  // 헬퍼: 크기 파싱
  parseSize(size) {
    const units = {
      b: 1,
      kb: 1024,
      mb: 1024 * 1024,
      gb: 1024 * 1024 * 1024
    };
    
    const match = size.match(/^(\d+)([a-zA-Z]+)$/);
    if (!match) return 10 * 1024 * 1024; // 기본 10MB
    
    const value = parseInt(match[1]);
    const unit = match[2].toLowerCase();
    
    return value * (units[unit] || units.mb);
  }
};

module.exports = validationMiddleware;
