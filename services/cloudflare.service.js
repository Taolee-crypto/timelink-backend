const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');
const constants = require('../config/constants');

class CloudflareService {
  constructor() {
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
      },
    });
    
    this.bucketName = process.env.CLOUDFLARE_R2_BUCKET_NAME || 'timelink-content';
  }

  async uploadFile(fileBuffer, filename, metadata = {}) {
    try {
      const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
      const fileKey = `uploads/${fileHash.slice(0, 8)}/${filename}`;

      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: fileKey,
        Body: fileBuffer,
        ContentType: metadata.contentType || 'application/octet-stream',
        Metadata: {
          'original-filename': metadata.originalName || filename,
          'file-hash': fileHash,
          'uploaded-at': new Date().toISOString(),
          'creator': metadata.creator || 'unknown',
          ...metadata
        }
      });

      await this.client.send(command);

      return {
        success: true,
        fileKey,
        fileHash,
        url: `https://pub-${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.dev/${fileKey}`,
        cdnUrl: `https://cdn.timelink.digital/${fileKey}`,
        size: fileBuffer.length,
        uploadedAt: new Date()
      };

    } catch (error) {
      console.error('Cloudflare R2 upload error:', error);
      throw error;
    }
  }

  async getFileUrl(fileKey, expiresIn = 3600) {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: fileKey
      });

      const url = await getSignedUrl(this.client, command, { expiresIn });
      return url;

    } catch (error) {
      console.error('Get signed URL error:', error);
      throw error;
    }
  }

  async deleteFile(fileKey) {
    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: fileKey
      });

      await this.client.send(command);

      return {
        success: true,
        message: 'File deleted successfully',
        fileKey,
        deletedAt: new Date()
      };

    } catch (error) {
      console.error('Delete file error:', error);
      throw error;
    }
  }

  async uploadThumbnail(imageBuffer, originalFileKey) {
    try {
      const thumbnailKey = originalFileKey.replace('/uploads/', '/thumbnails/') + '_thumb.jpg';
      
      // 실제로는 이미지 리사이징 로직이 필요
      // 임시로 원본 버퍼 사용
      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: thumbnailKey,
        Body: imageBuffer,
        ContentType: 'image/jpeg',
        Metadata: {
          'thumbnail-for': originalFileKey,
          'generated-at': new Date().toISOString()
        }
      });

      await this.client.send(command);

      return {
        success: true,
        thumbnailKey,
        url: `https://cdn.timelink.digital/${thumbnailKey}`
      };

    } catch (error) {
      console.error('Thumbnail upload error:', error);
      throw error;
    }
  }

  async generateStreamingUrl(fileKey, options = {}) {
    try {
      // HLS/DASH 스트리밍 URL 생성
      // 실제 구현에서는 Cloudflare Stream 사용
      
      const streamingUrl = `https://stream.timelink.digital/${fileKey}`;
      
      return {
        success: true,
        streamingUrl,
        hlsUrl: `${streamingUrl}/manifest.m3u8`,
        dashUrl: `${streamingUrl}/manifest.mpd`,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24시간
      };

    } catch (error) {
      console.error('Generate streaming URL error:', error);
      throw error;
    }
  }

  async checkFileExists(fileKey) {
    try {
      // 실제 구현에서는 HeadObjectCommand 사용
      // 임시로 항상 true 반환
      return {
        exists: true,
        fileKey,
        checkedAt: new Date()
      };

    } catch (error) {
      return {
        exists: false,
        fileKey,
        error: error.message
      };
    }
  }

  async getStorageUsage() {
    try {
      // 실제 구현에서는 Cloudflare API로 스토리지 사용량 조회
      // 임시 데이터 반환
      return {
        totalUsed: '15.2 GB',
        fileCount: 1245,
        videoFiles: 890,
        audioFiles: 210,
        imageFiles: 145,
        lastUpdated: new Date()
      };

    } catch (error) {
      console.error('Get storage usage error:', error);
      throw error;
    }
  }

  async generateUploadUrl(filename, contentType, metadata = {}) {
    try {
      // 클라이언트에서 직접 업로드할 수 있는 사전 서명된 URL 생성
      const fileHash = crypto.randomBytes(8).toString('hex');
      const fileKey = `direct-uploads/${Date.now()}_${fileHash}_${filename}`;
      
      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: fileKey,
        ContentType: contentType,
        Metadata: metadata
      });

      const url = await getSignedUrl(this.client, command, { expiresIn: 3600 });

      return {
        success: true,
        uploadUrl: url,
        fileKey,
        expiresIn: 3600,
        method: 'PUT'
      };

    } catch (error) {
      console.error('Generate upload URL error:', error);
      throw error;
    }
  }

  async migrateFile(sourceUrl, destinationKey) {
    try {
      // 외부 URL에서 R2로 파일 마이그레이션
      const response = await fetch(sourceUrl);
      const buffer = await response.arrayBuffer();
      
      const result = await this.uploadFile(Buffer.from(buffer), destinationKey);

      return {
        success: true,
        originalUrl: sourceUrl,
        migratedTo: result.url,
        size: buffer.byteLength
      };

    } catch (error) {
      console.error('File migration error:', error);
      throw error;
    }
  }
}

module.exports = new CloudflareService();
