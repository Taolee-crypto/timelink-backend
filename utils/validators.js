const { ethers } = require('ethers');
const constants = require('../config/constants');

const validators = {
  // 이더리움 주소 검증
  isEthereumAddress: (address) => {
    try {
      return ethers.isAddress(address);
    } catch (error) {
      return false;
    }
  },

  // 이더리움 서명 검증
  isEthereumSignature: (signature) => {
    const signatureRegex = /^0x[a-fA-F0-9]{130}$/;
    return signatureRegex.test(signature);
  },

  // 파일 타입 검증
  isValidFileType: (mimetype, originalname) => {
    const extension = originalname.split('.').pop().toLowerCase();
    
    for (const [type, extensions] of Object.entries(constants.TLF.SUPPORTED_FORMATS)) {
      if (extensions.includes(extension)) {
        return {
          valid: true,
          type,
          extension
        };
      }
    }
    
    return {
      valid: false,
      type: 'unknown',
      extension
    };
  },

  // 파일 크기 검증
  isValidFileSize: (size) => {
    return size <= constants.TLF.MAX_FILE_SIZE;
  },

  // 비밀번호 강도 검증
  validatePasswordStrength: (password) => {
    const checks = {
      minLength: password.length >= 8,
      hasUpperCase: /[A-Z]/.test(password),
      hasLowerCase: /[a-z]/.test(password),
      hasNumbers: /\d/.test(password),
      hasSpecialChar: /[!@#$%^&*(),.?":{}|<>]/.test(password)
    };

    const passedChecks = Object.values(checks).filter(Boolean).length;
    const strength = (passedChecks / Object.keys(checks).length) * 100;

    return {
      strength,
      passed: passedChecks === Object.keys(checks).length,
      checks
    };
  },

  // 이메일 검증
  isValidEmail: (email) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  },

  // URL 검증
  isValidURL: (url) => {
    try {
      new URL(url);
      return true;
    } catch (error) {
      return false;
    }
  },

  // 가격 검증
  isValidPrice: (price) => {
    const numPrice = parseFloat(price);
    return !isNaN(numPrice) && 
           numPrice >= constants.PRICING.MIN_PRICE_PER_MINUTE && 
           numPrice <= constants.PRICING.MAX_PRICE_PER_MINUTE;
  },

  // TLF ID 검증
  isValidTLFId: (tlfId) => {
    const tlfIdRegex = /^TLF_[a-zA-Z0-9]+_[a-zA-Z0-9]+$/;
    return tlfIdRegex.test(tlfId);
  },

  // 트랜잭션 해시 검증
  isValidTransactionHash: (hash) => {
    const txHashRegex = /^0x[a-fA-F0-9]{64}$/;
    return txHashRegex.test(hash);
  },

  // IP 주소 검증
  isValidIPAddress: (ip) => {
    const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    const ipv6Regex = /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/;
    return ipv4Regex.test(ip) || ipv6Regex.test(ip);
  },

  // 날짜 문자열 검증 (ISO 8601)
  isValidISODate: (dateString) => {
    const date = new Date(dateString);
    return !isNaN(date.getTime()) && dateString === date.toISOString();
  },

  // JSON 문자열 검증
  isValidJSON: (str) => {
    try {
      JSON.parse(str);
      return true;
    } catch (error) {
      return false;
    }
  },

  // MongoDB ObjectId 검증
  isValidObjectId: (id) => {
    const objectIdRegex = /^[0-9a-fA-F]{24}$/;
    return objectIdRegex.test(id);
  },

  // 태그 배열 검증
  isValidTags: (tags) => {
    if (!Array.isArray(tags)) return false;
    if (tags.length > 10) return false; // 최대 10개 태그
    
    for (const tag of tags) {
      if (typeof tag !== 'string') return false;
      if (tag.length < 1 || tag.length > 30) return false;
      if (!/^[a-zA-Z0-9가-힣\s\-_]+$/.test(tag)) return false;
    }
    
    return true;
  },

  // 사용자 이름 검증
  isValidUsername: (username) => {
    if (typeof username !== 'string') return false;
    if (username.length < 3 || username.length > 30) return false;
    return /^[a-zA-Z0-9_]+$/.test(username);
  },

  // 카테고리 검증
  isValidCategory: (category) => {
    if (typeof category !== 'string') return false;
    if (category.length < 1 || category.length > 50) return false;
    return true;
  },

  // 설명 검증
  isValidDescription: (description) => {
    if (!description) return true; // 선택사항
    if (typeof description !== 'string') return false;
    if (description.length > 1000) return false;
    return true;
  },

  // 숫자 범위 검증
  isInRange: (value, min, max) => {
    const num = parseFloat(value);
    return !isNaN(num) && num >= min && num <= max;
  },

  // 배열 길이 검증
  isValidArrayLength: (array, min = 0, max = Infinity) => {
    if (!Array.isArray(array)) return false;
    return array.length >= min && array.length <= max;
  },

  // 포인트 값 검증
  isValidPoints: (points) => {
    const num = parseInt(points);
    return !isNaN(num) && num >= 0 && num <= 1000000; // 최대 100만 포인트
  },

  // 시간 범위 검증 (초 단위)
  isValidDuration: (duration) => {
    const num = parseInt(duration);
    return !isNaN(num) && num >= 0 && num <= constants.TLF.MAX_DURATION;
  },

  // 파일 이름 검증
  isValidFilename: (filename) => {
    if (typeof filename !== 'string') return false;
    if (filename.length < 1 || filename.length > 255) return false;
    
    // 금지된 문자 체크
    const forbiddenChars = /[<>:"/\\|?*\x00-\x1F]/;
    if (forbiddenChars.test(filename)) return false;
    
    // 예약된 이름 체크
    const reservedNames = ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM2', 'COM3', 'COM4', 
                          'COM5', 'COM6', 'COM7', 'COM8', 'COM9', 'LPT1', 'LPT2', 
                          'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'];
    if (reservedNames.includes(filename.toUpperCase().split('.')[0])) return false;
    
    return true;
  },

  // MIME 타입 검증
  isValidMimeType: (mimetype) => {
    const validMimeTypes = Object.values(constants.TLF.SUPPORTED_FORMATS)
      .flat()
      .map(ext => {
        switch (ext) {
          case 'mp4': return 'video/mp4';
          case 'mov': return 'video/quicktime';
          case 'avi': return 'video/x-msvideo';
          case 'mkv': return 'video/x-matroska';
          case 'mp3': return 'audio/mpeg';
          case 'wav': return 'audio/wav';
          case 'flac': return 'audio/flac';
          case 'jpg': case 'jpeg': return 'image/jpeg';
          case 'png': return 'image/png';
          case 'gif': return 'image/gif';
          case 'pdf': return 'application/pdf';
          case 'txt': return 'text/plain';
          case 'md': return 'text/markdown';
          default: return null;
        }
      })
      .filter(Boolean);
    
    return validMimeTypes.includes(mimetype);
  },

  // 상태 값 검증
  isValidStatus: (status, validStatuses) => {
    return validStatuses.includes(status);
  },

  // 정렬 방향 검증
  isValidSortOrder: (order) => {
    return ['asc', 'desc', '1', '-1'].includes(order.toString());
  },

  // 페이지 번호 검증
  isValidPage: (page) => {
    const num = parseInt(page);
    return !isNaN(num) && num >= 1;
  },

  // 제한 값 검증
  isValidLimit: (limit, max = 100) => {
    const num = parseInt(limit);
    return !isNaN(num) && num >= 1 && num <= max;
  },

  // 정규식 검증 헬퍼
  matchesPattern: (value, pattern) => {
    const regex = new RegExp(pattern);
    return regex.test(value);
  },

  // 데이터 위생 처리 (XSS 방지)
  sanitizeInput: (input) => {
    if (typeof input !== 'string') return input;
    
    // HTML 태그 제거
    let sanitized = input.replace(/<[^>]*>/g, '');
    
    // 특수 문자 이스케이프
    sanitized = sanitized
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
      .replace(/\//g, '&#x2F;');
    
    // 줄바꿈 처리
    sanitized = sanitized.replace(/\n/g, '<br>');
    
    return sanitized;
  },

  // 숫자 포맷팅 검증
  isValidNumberFormat: (value, decimals = 2) => {
    const regex = new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`);
    return regex.test(value.toString());
  },

  // 퍼센트 값 검증
  isValidPercentage: (percentage) => {
    const num = parseFloat(percentage);
    return !isNaN(num) && num >= 0 && num <= 100;
  },

  // RGB 색상 코드 검증
  isValidRGBColor: (color) => {
    const rgbRegex = /^rgb\((\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})\)$/;
    if (!rgbRegex.test(color)) return false;
    
    const matches = color.match(rgbRegex);
    const r = parseInt(matches[1]);
    const g = parseInt(matches[2]);
    const b = parseInt(matches[3]);
    
    return r >= 0 && r <= 255 && 
           g >= 0 && g <= 255 && 
           b >= 0 && b <= 255;
  },

  // HEX 색상 코드 검증
  isValidHexColor: (color) => {
    const hexRegex = /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/;
    return hexRegex.test(color);
  },

  // 데이터 검증 결과 포맷팅
  formatValidationResult: (isValid, message = '', data = null) => {
    return {
      valid: isValid,
      message: isValid ? 'Validation passed' : message,
      timestamp: new Date(),
      data
    };
  }
};

module.exports = validators;
