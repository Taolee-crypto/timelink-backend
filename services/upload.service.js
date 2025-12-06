const File = require('../models/File');
const User = require('../models/User');
const { v4: uuidv4 } = require('uuid');

class UploadService {
  constructor() {
    this.processingQueue = new Map();
  }

  async handleUpload(fileBuffer, metadata, userId) {
    try {
      // 1. 파일 메타데이터 추출
      const fileInfo = await this.extractFileInfo(fileBuffer, metadata);
      
      // 2. 고유 ID 생성
      const fileId = `file_${Date.now()}_${uuidv4().slice(0, 8)}`;
      const tlfId = `tlf_${Date.now()}_${uuidv4().slice(0, 12)}`;
      
      // 3. 임시 저장 (실제로는 Cloudflare R2에 업로드)
      const storageUrl = await this.uploadToStorage(fileBuffer, fileId);
      
      // 4. 데이터베이스에 파일 정보 저장
      const fileDoc = new File({
        filename: fileId,
        originalName: metadata.originalName,
        fileType: fileInfo.type,
        fileSize: fileBuffer.length,
        duration: fileInfo.duration,
        tlfId: tlfId,
        storageUrl: storageUrl,
        title: metadata.title,
        description: metadata.description,
        pricePerMinute: metadata.pricePerMinute || 0.1,
        isFree: metadata.isFree || false,
        creatorId: userId,
        creatorAddress: metadata.creatorAddress,
        status: 'processing'
      });

      await fileDoc.save();
      
      // 5. 사용자 업로드 통계 업데이트
      await User.findByIdAndUpdate(userId, {
        $inc: { uploadedFiles: 1 }
      });

      // 6. 처리 큐에 추가
      this.processingQueue.set(fileId, {
        fileId,
        tlfId,
        status: 'processing',
        progress: 10,
        message: 'File uploaded, starting TLF conversion...'
      });

      // 7. 비동기 처리 시작
      this.processFileAsync(fileId, tlfId, fileInfo);

      return {
        fileId,
        tlfId,
        storageUrl,
        processing: true
      };

    } catch (error) {
      console.error('Upload service error:', error);
      throw error;
    }
  }

  async extractFileInfo(buffer, metadata) {
    // 파일 타입별 메타데이터 추출
    const mimeType = metadata.mimetype;
    
    if (mimeType.startsWith('video/')) {
      return {
        type: 'video',
        duration: metadata.duration || await this.extractVideoDuration(buffer)
      };
    } else if (mimeType.startsWith('audio/')) {
      return {
        type: 'audio', 
        duration: metadata.duration || await this.extractAudioDuration(buffer)
      };
    } else if (mimeType.startsWith('image/')) {
      return { type: 'image' };
    } else {
      return { type: 'document' };
    }
  }

  async uploadToStorage(buffer, fileId) {
    // 실제 구현에서는 Cloudflare R2에 업로드
    // 임시로 가상 URL 반환
    return `https://r2.timelink.digital/${fileId}`;
  }

  async processFileAsync(fileId, tlfId, fileInfo) {
    try {
      // TLF 변환 프로세스 시뮬레이션
      const steps = [
        { progress: 20, message: 'Validating file format...' },
        { progress: 40, message: 'Extracting metadata...' },
        { progress: 60, message: 'Generating thumbnail...' },
        { progress: 80, message: 'Creating TLF hash...' },
        { progress: 95, message: 'Finalizing...' },
        { progress: 100, message: 'TLF created successfully!' }
      ];

      for (const step of steps) {
        await this.delay(1000); // 1초 대기
        this.updateProcessingStatus(fileId, step.progress, step.message);
      }

      // 최종 상태 업데이트
      await File.findOneAndUpdate(
        { tlfId: tlfId },
        { 
          status: 'ready',
          $unset: { processingStatus: 1 }
        }
      );

      this.processingQueue.delete(fileId);

    } catch (error) {
      console.error('Async processing error:', error);
      this.updateProcessingStatus(fileId, 0, `Error: ${error.message}`);
      await File.findOneAndUpdate(
        { tlfId: tlfId },
        { status: 'failed' }
      );
    }
  }

  updateProcessingStatus(fileId, progress, message) {
    if (this.processingQueue.has(fileId)) {
      const status = this.processingQueue.get(fileId);
      status.progress = progress;
      status.message = message;
      this.processingQueue.set(fileId, status);
    }
  }

  getProcessingStatus(fileId) {
    return this.processingQueue.get(fileId) || { 
      status: 'not_found', 
      progress: 0, 
      message: 'File not in processing queue' 
    };
  }

  async getUserFiles(userId, options = {}) {
    const { page = 1, limit = 20, status } = options;
    const skip = (page - 1) * limit;

    const query = { creatorId: userId };
    if (status) query.status = status;

    const [files, total] = await Promise.all([
      File.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      File.countDocuments(query)
    ]);

    return {
      files,
      total,
      page,
      totalPages: Math.ceil(total / limit)
    };
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = new UploadService();
