const crypto = require('crypto');
const bcrypt = require('bcryptjs');

class EncryptionUtils {
  constructor() {
    this.algorithm = 'aes-256-gcm';
    this.ivLength = 16;
    this.saltRounds = 10;
  }

  // AES 암호화
  encrypt(text, key) {
    try {
      const iv = crypto.randomBytes(this.ivLength);
      const cipher = crypto.createCipheriv(this.algorithm, this._getKey(key), iv);
      
      let encrypted = cipher.update(text, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      
      const authTag = cipher.getAuthTag();
      
      return {
        encrypted,
        iv: iv.toString('hex'),
        authTag: authTag.toString('hex')
      };
    } catch (error) {
      throw new Error(`Encryption failed: ${error.message}`);
    }
  }

  // AES 복호화
  decrypt(encryptedData, key) {
    try {
      const { encrypted, iv, authTag } = encryptedData;
      
      const decipher = crypto.createDecipheriv(
        this.algorithm,
        this._getKey(key),
        Buffer.from(iv, 'hex')
      );
      
      decipher.setAuthTag(Buffer.from(authTag, 'hex'));
      
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      
      return decrypted;
    } catch (error) {
      throw new Error(`Decryption failed: ${error.message}`);
    }
  }

  // 비밀번호 해싱
  async hashPassword(password) {
    try {
      const salt = await bcrypt.genSalt(this.saltRounds);
      const hash = await bcrypt.hash(password, salt);
      return hash;
    } catch (error) {
      throw new Error(`Password hashing failed: ${error.message}`);
    }
  }

  // 비밀번호 검증
  async verifyPassword(password, hash) {
    try {
      return await bcrypt.compare(password, hash);
    } catch (error) {
      throw new Error(`Password verification failed: ${error.message}`);
    }
  }

  // JWT 토큰 생성 (간단한 버전)
  createToken(payload, secret, expiresIn = '7d') {
    try {
      const header = {
        alg: 'HS256',
        typ: 'JWT'
      };

      const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
      const encodedPayload = Buffer.from(JSON.stringify({
        ...payload,
        exp: Math.floor(Date.now() / 1000) + this._parseExpiresIn(expiresIn)
      })).toString('base64url');

      const signatureInput = `${encodedHeader}.${encodedPayload}`;
      const signature = crypto
        .createHmac('sha256', secret)
        .update(signatureInput)
        .digest('base64url');

      return `${signatureInput}.${signature}`;
    } catch (error) {
      throw new Error(`Token creation failed: ${error.message}`);
    }
  }

  // JWT 토큰 검증
  verifyToken(token, secret) {
    try {
      const [encodedHeader, encodedPayload, signature] = token.split('.');
      
      const signatureInput = `${encodedHeader}.${encodedPayload}`;
      const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(signatureInput)
        .digest('base64url');

      if (signature !== expectedSignature) {
        throw new Error('Invalid signature');
      }

      const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString());
      
      // 만료 확인
      if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
        throw new Error('Token expired');
      }

      return payload;
    } catch (error) {
      throw new Error(`Token verification failed: ${error.message}`);
    }
  }

  // 해시 생성 (SHA256)
  createHash(data, algorithm = 'sha256') {
    try {
      return crypto
        .createHash(algorithm)
        .update(typeof data === 'string' ? data : JSON.stringify(data))
        .digest('hex');
    } catch (error) {
      throw new Error(`Hash creation failed: ${error.message}`);
    }
  }

  // HMAC 서명
  createHMAC(data, key, algorithm = 'sha256') {
    try {
      return crypto
        .createHmac(algorithm, key)
        .update(typeof data === 'string' ? data : JSON.stringify(data))
        .digest('hex');
    } catch (error) {
      throw new Error(`HMAC creation failed: ${error.message}`);
    }
  }

  // 랜덤 문자열 생성
  generateRandomString(length = 32, type = 'alphanumeric') {
    const chars = {
      alphanumeric: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
      numeric: '0123456789',
      hex: '0123456789abcdef',
      alphabetic: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
    };

    const characterSet = chars[type] || chars.alphanumeric;
    let result = '';
    
    for (let i = 0; i < length; i++) {
      result += characterSet.charAt(Math.floor(Math.random() * characterSet.length));
    }
    
    return result;
  }

  // API 키 생성
  generateApiKey(prefix = 'tlk') {
    const randomPart = this.generateRandomString(32, 'hex');
    const timestamp = Date.now().toString(36);
    
    return `${prefix}_${timestamp}_${randomPart}`;
  }

  // 파일 해시 생성
  async createFileHash(fileBuffer, algorithm = 'sha256') {
    return new Promise((resolve, reject) => {
      try {
        const hash = crypto.createHash(algorithm);
        hash.update(fileBuffer);
        resolve(hash.digest('hex'));
      } catch (error) {
        reject(new Error(`File hash creation failed: ${error.message}`));
      }
    });
  }

  // 안전한 랜덤 바이트 생성
  generateSecureRandomBytes(length) {
    return crypto.randomBytes(length);
  }

  // 데이터 마스킹 (로그 등에 사용)
  maskData(data, visibleChars = 4) {
    if (!data || data.length <= visibleChars * 2) {
      return '*'.repeat(data?.length || 0);
    }

    const firstPart = data.substring(0, visibleChars);
    const lastPart = data.substring(data.length - visibleChars);
    const maskedMiddle = '*'.repeat(data.length - visibleChars * 2);

    return `${firstPart}${maskedMiddle}${lastPart}`;
  }

  // 암호 강도 검증
  validatePasswordStrength(password) {
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
  }

  // 개인키 기반 주소 생성 (테스트용)
  generateWalletAddress() {
    const privateKey = crypto.randomBytes(32).toString('hex');
    const publicKey = this.privateKeyToPublicKey(privateKey);
    const address = this.publicKeyToAddress(publicKey);
    
    return {
      privateKey,
      publicKey,
      address: `0x${address}`
    };
  }

  // 헬퍼 메서드들
  _getKey(key) {
    // 32바이트 키로 변환
    return crypto.createHash('sha256').update(key).digest();
  }

  _parseExpiresIn(expiresIn) {
    const unit = expiresIn.slice(-1);
    const value = parseInt(expiresIn.slice(0, -1));
    
    switch (unit) {
      case 's': return value; // 초
      case 'm': return value * 60; // 분
      case 'h': return value * 60 * 60; // 시간
      case 'd': return value * 60 * 60 * 24; // 일
      default: return 7 * 24 * 60 * 60; // 기본 7일
    }
  }

  // 테스트용 메서드 (실제 블록체인 연동 시 변경 필요)
  privateKeyToPublicKey(privateKey) {
    const ecdh = crypto.createECDH('secp256k1');
    ecdh.setPrivateKey(Buffer.from(privateKey, 'hex'));
    return ecdh.getPublicKey('hex');
  }

  publicKeyToAddress(publicKey) {
    const hash = crypto.createHash('sha256').update(Buffer.from(publicKey, 'hex')).digest();
    const ripemd160 = crypto.createHash('ripemd160').update(hash).digest();
    return ripemd160.toString('hex').slice(0, 40);
  }
}

module.exports = new EncryptionUtils();
