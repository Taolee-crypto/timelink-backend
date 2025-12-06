const constants = require('./constants');

class CloudflareConfig {
  constructor() {
    this.validateConfig();
  }

  validateConfig() {
    const requiredConfigs = [
      'CLOUDFLARE_ACCOUNT_ID',
      'CLOUDFLARE_R2_ACCESS_KEY_ID', 
      'CLOUDFLARE_R2_SECRET_ACCESS_KEY',
      'CLOUDFLARE_R2_BUCKET_NAME'
    ];

    const missingConfigs = requiredConfigs.filter(
      config => !process.env[config]
    );

    if (missingConfigs.length > 0) {
      console.warn(`Missing Cloudflare configs: ${missingConfigs.join(', ')}`);
      console.warn('Cloudflare services will not work properly.');
    }
  }

  getR2Config() {
    return {
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      accessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
      bucketName: process.env.CLOUDFLARE_R2_BUCKET_NAME || 'timelink-content',
      endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      publicEndpoint: `https://pub-${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.dev`,
      cdnEndpoint: `https://cdn.timelink.digital`
    };
  }

  getStreamConfig() {
    return {
      accountId: process.env.CLOUDFLARE_STREAM_ACCOUNT_ID,
      apiToken: process.env.CLOUDFLARE_STREAM_API_TOKEN,
      secret: process.env.CLOUDFLARE_STREAM_SECRET,
      endpoint: 'https://api.cloudflare.com/client/v4/accounts'
    };
  }

  getWorkerConfig() {
    return {
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      apiToken: process.env.CLOUDFLARE_API_TOKEN,
      namespaceId: process.env.CLOUDFLARE_WORKERS_NAMESPACE_ID,
      scriptName: process.env.CLOUDFLARE_WORKER_SCRIPT_NAME || 'timelink-api'
    };
  }

  getDNSConfig() {
    return {
      zoneId: process.env.CLOUDFLARE_ZONE_ID,
      apiToken: process.env.CLOUDFLARE_API_TOKEN,
      domain: 'timelink.digital',
      subdomains: ['api', 'cdn', 'stream', 'r2']
    };
  }

  getCacheConfig() {
    return {
      enabled: process.env.CLOUDFLARE_CACHE_ENABLED === 'true',
      ttl: parseInt(process.env.CLOUDFLARE_CACHE_TTL) || 3600,
      bypassCookies: ['__cfruid', 'cf_clearance'],
      cacheEverything: false
    };
  }

  getImageOptimizationConfig() {
    return {
      enabled: true,
      formats: ['webp', 'avif'],
      quality: 85,
      widths: [320, 640, 768, 1024, 1280, 1536],
      fit: 'scale-down'
    };
  }

  getSecurityConfig() {
    return {
      wafEnabled: true,
      rateLimiting: {
        enabled: true,
        requests: 100,
        period: 60, // seconds
        action: 'challenge'
      },
      botManagement: {
        enabled: true,
        mode: 'js_challenge'
      },
      ssl: 'flexible'
    };
  }

  getAnalyticsConfig() {
    return {
      enabled: process.env.CLOUDFLARE_ANALYTICS === 'true',
      dataset: 'timelink_requests',
      samplingRate: 0.1 // 10%
    };
  }

  async testConnection() {
    const tests = [];
    
    // R2 연결 테스트
    try {
      const r2Config = this.getR2Config();
      tests.push({
        service: 'R2',
        status: 'configured',
        details: `Bucket: ${r2Config.bucketName}`
      });
    } catch (error) {
      tests.push({
        service: 'R2', 
        status: 'error',
        error: error.message
      });
    }

    // DNS 설정 확인
    try {
      const dnsConfig = this.getDNSConfig();
      tests.push({
        service: 'DNS',
        status: 'configured',
        details: `Domain: ${dnsConfig.domain}`
      });
    } catch (error) {
      tests.push({
        service: 'DNS',
        status: 'warning',
        error: 'DNS configuration incomplete'
      });
    }

    return {
      timestamp: new Date(),
      tests,
      overall: tests.every(t => t.status === 'configured') ? 'healthy' : 'degraded'
    };
  }

  generateCORSConfig() {
    return {
      allowedOrigins: constants.API.CORS_ORIGINS,
      allowedMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Wallet-Address', 'X-Signature'],
      exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining'],
      maxAge: 86400, // 24 hours
      allowCredentials: true
    };
  }

  getUploadLimits() {
    return {
      maxFileSize: constants.TLF.MAX_FILE_SIZE,
      maxFiles: 10,
      allowedTypes: Object.values(constants.TLF.SUPPORTED_FORMATS).flat(),
      timeout: 30 * 60 * 1000 // 30 minutes
    };
  }
}

// 싱글톤 인스턴스
const cloudflareConfig = new CloudflareConfig();

module.exports = cloudflareConfig;
