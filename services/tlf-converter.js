const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

class TLFConverter {
  constructor() {
    this.version = 'TLFv1';
  }

  async convertToTLF(fileData, metadata) {
    try {
      // 1. TLF ID 생성
      const tlfId = this.generateTLFId();
      
      // 2. 해시 생성
      const fileHash = await this.calculateFileHash(fileData.buffer);
      const metadataHash = this.calculateMetadataHash(metadata);
      
      // 3. TLF 구조 생성
      const tlfStructure = {
        version: this.version,
        tlfId,
        fileHash,
        metadataHash,
        timestamp: new Date().toISOString(),
        content: {
          type: metadata.fileType,
          size: fileData.size,
          duration: metadata.duration,
          format: metadata.format
        },
        ownership: {
          creator: metadata.creatorAddress,
          createdAt: new Date().toISOString()
        },
        pricing: {
          pricePerMinute: metadata.pricePerMinute,
          currency: 'TLT',
          isFree: metadata.isFree || false
        },
        accessControl: {
          requiresPayment: !metadata.isFree,
          maxPlays: metadata.maxPlays || null,
          expiryDate: metadata.expiryDate || null
        }
      };

      // 4. TLF 해시 (전체 구조의 해시)
      const tlfHash = this.calculateTLFHash(tlfStructure);

      // 5. 최종 TLF 객체
      const tlfObject = {
        ...tlfStructure,
        tlfHash
      };

      console.log(`TLF created: ${tlfId}`);
      console.log(`File Hash: ${fileHash}`);
      console.log(`TLF Hash: ${tlfHash}`);

      return {
        success: true,
        tlfId,
        tlfHash,
        tlfObject,
        fileHash,
        timestamp: new Date()
      };

    } catch (error) {
      console.error('TLF conversion error:', error);
      throw error;
    }
  }

  generateTLFId() {
    const timestamp = Date.now().toString(36);
    const random = uuidv4().replace(/-/g, '').slice(0, 8);
    return `TLF_${timestamp}_${random}`.toUpperCase();
  }

  async calculateFileHash(buffer) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      hash.update(buffer);
      resolve(hash.digest('hex'));
    });
  }

  calculateMetadataHash(metadata) {
    const sortedMetadata = this.sortObject(metadata);
    const metadataString = JSON.stringify(sortedMetadata);
    return crypto.createHash('sha256').update(metadataString).digest('hex');
  }

  calculateTLFHash(tlfStructure) {
    const tlfString = JSON.stringify(this.sortObject(tlfStructure));
    return crypto.createHash('sha512').update(tlfString).digest('hex');
  }

  sortObject(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(this.sortObject);
    
    return Object.keys(obj)
      .sort()
      .reduce((sorted, key) => {
        sorted[key] = this.sortObject(obj[key]);
        return sorted;
      }, {});
  }

  async verifyTLF(tlfObject, fileBuffer) {
    try {
      // 1. TLF 해시 검증
      const calculatedHash = this.calculateTLFHash(tlfObject);
      if (calculatedHash !== tlfObject.tlfHash) {
        return { valid: false, reason: 'TLF hash mismatch' };
      }

      // 2. 파일 해시 검증
      const fileHash = await this.calculateFileHash(fileBuffer);
      if (fileHash !== tlfObject.fileHash) {
        return { valid: false, reason: 'File hash mismatch' };
      }

      // 3. 메타데이터 해시 검증
      const metadata = {
        title: tlfObject.content.title,
        description: tlfObject.content.description,
        creator: tlfObject.ownership.creator,
        // 필요한 다른 메타데이터들
      };
      const metadataHash = this.calculateMetadataHash(metadata);
      if (metadataHash !== tlfObject.metadataHash) {
        return { valid: false, reason: 'Metadata hash mismatch' };
      }

      // 4. 유효성 검사
      if (!this.validateTLFStructure(tlfObject)) {
        return { valid: false, reason: 'Invalid TLF structure' };
      }

      return {
        valid: true,
        tlfId: tlfObject.tlfId,
        verificationTime: new Date()
      };

    } catch (error) {
      console.error('TLF verification error:', error);
      return { valid: false, reason: error.message };
    }
  }

  validateTLFStructure(tlfObject) {
    const requiredFields = [
      'version', 'tlfId', 'fileHash', 'metadataHash', 'tlfHash',
      'timestamp', 'content', 'ownership'
    ];

    for (const field of requiredFields) {
      if (!tlfObject[field]) {
        console.error(`Missing required field: ${field}`);
        return false;
      }
    }

    // 버전 체크
    if (!tlfObject.version.startsWith('TLFv')) {
      console.error('Invalid TLF version');
      return false;
    }

    // 해시 길이 체크
    if (tlfObject.fileHash.length !== 64) { // SHA-256 = 64 chars
      console.error('Invalid file hash length');
      return false;
    }

    if (tlfObject.tlfHash.length !== 128) { // SHA-512 = 128 chars
      console.error('Invalid TLF hash length');
      return false;
    }

    return true;
  }

  async generateTLFManifest(tlfId, options = {}) {
    // TLF 매니페스트 생성 (IPFS 등에 저장될 정보)
    const manifest = {
      tlfId,
      version: this.version,
      created: new Date().toISOString(),
      ...options
    };

    const manifestHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(manifest))
      .digest('hex');

    return {
      manifest,
      manifestHash,
      ipfsCid: await this.simulateIPFSUpload(manifest) // 실제로는 IPFS 업로드
    };
  }

  async simulateIPFSUpload(data) {
    // 실제 구현에서는 IPFS에 업로드
    const mockCid = `Qm${Array.from({ length: 44 }, () => 
      'abcdefghijklmnopqrstuvwxyz0123456789'[
        Math.floor(Math.random() * 36)
      ]
    ).join('')}`;
    
    return mockCid;
  }

  async extractTLFMetadata(tlfObject) {
    return {
      basic: {
        id: tlfObject.tlfId,
        type: tlfObject.content.type,
        size: tlfObject.content.size,
        duration: tlfObject.content.duration,
        createdAt: tlfObject.ownership.createdAt
      },
      ownership: {
        creator: tlfObject.ownership.creator,
        pricePerMinute: tlfObject.pricing.pricePerMinute,
        isFree: tlfObject.pricing.isFree
      },
      technical: {
        fileHash: tlfObject.fileHash,
        tlfHash: tlfObject.tlfHash,
        version: tlfObject.version
      }
    };
  }
}

module.exports = new TLFConverter();
