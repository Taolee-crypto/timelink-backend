// 기존 TimeLink + 새로운 Deconomic 통합 매니저
export class HybridManager {
  constructor(env) {
    // 기존 TimeLink KV들
    this.TIME_DATA = env.TIME_DATA;      // 통계/로그
    this.API_CONFIG = env.API_CONFIG;    // 설정값
    this.USERS_PRIMARY = env.USERS_PRIMARY;  // 메인 사용자 DB
    this.USERS_CACHE = env.USERS_CACHE;  // 사용자 캐시
    this.SESSIONS = env.SESSIONS;        // 세션
    
    // 새로운 Deconomic KV들
    this.ASSETS = env.DECONOMIC_ASSETS;  // 디지털 자산
    this.TRANSACTIONS = env.DECONOMIC_TX; // TL 거래
  }

  // ========== 기존 TimeLink 기능 호환 ==========
  async getTimeLinkUser(email) {
    // 기존 사용자 데이터 조회 (USERS_PRIMARY)
    const userKey = `user:${email}`;
    return await this.USERS_PRIMARY.get(userKey, { type: 'json' });
  }

  async updateTimeLinkUser(email, userData) {
    const userKey = `user:${email}`;
    await this.USERS_PRIMARY.put(userKey, JSON.stringify(userData));
    
    // 캐시에도 업데이트
    await this.USERS_CACHE.put(userKey, JSON.stringify(userData));
    
    return userData;
  }

  async migrateToDeconomic(email) {
    // 기존 TimeLink 사용자를 Deconomic 형식으로 마이그레이션
    const timeLinkUser = await this.getTimeLinkUser(email);
    
    if (!timeLinkUser) return null;
    
    // Deconomic 사용자 형식으로 변환
    const deconomicUser = {
      ...timeLinkUser,
      tlBalance: timeLinkUser.balance || 1000, // 기존 잔액 또는 기본값
      userType: this.determineUserType(timeLinkUser),
      migratedAt: new Date().toISOString(),
      originalSource: 'timelink'
    };
    
    // USERS_PRIMARY에 Deconomic 형식으로 업데이트
    await this.updateTimeLinkUser(email, deconomicUser);
    
    return deconomicUser;
  }

  // ========== 새로운 Deconomic 기능 ==========
  async createDeconomicUser(userData) {
    const userId = `DUSER_${Date.now()}`;
    const user = {
      id: userId,
      ...userData,
      tlBalance: 1000,
      userType: 'consumer',
      source: 'deconomic',
      createdAt: new Date().toISOString()
    };

    // 기존 USERS_PRIMARY에 저장
    await this.USERS_PRIMARY.put(`user:${userData.email}`, JSON.stringify(user));
    
    // TIME_DATA에 가입 로그 기록
    await this.logActivity('user_signup', {
      userId,
      email: userData.email,
      timestamp: new Date().toISOString()
    });

    return user;
  }

  async createAsset(assetData) {
    const assetId = `ASSET_${Date.now()}`;
    const asset = {
      id: assetId,
      ...assetData,
      tlType: this.determineTLType(assetData.fileType),
      tlCharged: 0,
      tlConsumed: 0,
      tlRemaining: 0,
      earnings: 0,
      isActive: false,
      createdAt: new Date().toISOString()
    };

    await this.ASSETS.put(assetId, JSON.stringify(asset));
    
    // TIME_DATA에 자산 생성 로그
    await this.logActivity('asset_created', {
      assetId,
      fileType: assetData.fileType,
      uploader: assetData.uploaderEmail
    });

    return asset;
  }

  // ========== TL 경제 시스템 ==========
  async chargeTL(email, amount, method = 'ad_reward') {
    const user = await this.getTimeLinkUser(email) || 
                 await this.createDeconomicUser({ email, username: email.split('@')[0] });
    
    const newBalance = (user.tlBalance || 0) + amount;
    user.tlBalance = newBalance;
    
    // 사용자 업데이트
    await this.updateTimeLinkUser(email, user);
    
    // 트랜잭션 기록
    const tx = await this.logTransaction({
      type: 'charge',
      userId: user.id || email,
      amount,
      method,
      balanceBefore: user.tlBalance - amount,
      balanceAfter: newBalance
    });
    
    // API_CONFIG에 TL 충전 통계 업데이트
    await this.updateTLStats(amount);
    
    return { user, transaction: tx };
  }

  async consumeTL(assetId, consumerEmail) {
    const asset = await this.ASSETS.get(assetId, { type: 'json' });
    if (!asset || asset.tlRemaining <= 0) {
      throw new Error('자산이 활성화되지 않았거나 TL이 부족합니다');
    }
    
    const consumer = await this.getTimeLinkUser(consumerEmail);
    if (!consumer) {
      throw new Error('사용자를 찾을 수 없습니다');
    }
    
    // TL 소비 (기본 1 TL)
    const tlConsumed = 1;
    asset.tlConsumed += tlConsumed;
    asset.tlRemaining -= tlConsumed;
    asset.views = (asset.views || 0) + 1;
    
    await this.ASSETS.put(assetId, JSON.stringify(asset));
    
    // 수익 배분 계산
    const earnings = this.calculateEarnings(tlConsumed);
    
    // 저작권자와 업로더에게 분배
    await this.distributeEarnings(asset, earnings);
    
    // 트랜잭션 기록
    await this.logTransaction({
      type: 'consumption',
      userId: consumer.id || consumerEmail,
      assetId,
      amount: tlConsumed,
      earnings
    });
    
    return { asset, tlConsumed, earnings };
  }

  // ========== 유틸리티 메서드 ==========
  determineTLType(fileType) {
    const typeMap = {
      'audio': 'TL3',
      'video': 'TL4', 
      'document': 'TLD',
      'image': 'TLI',
      'ebook': 'TLE',
      'default': 'TL0'
    };
    return typeMap[fileType.toLowerCase()] || typeMap.default;
  }

  determineUserType(userData) {
    if (userData.isAdmin) return 'admin';
    if (userData.isCreator) return 'creator';
    return 'consumer';
  }

  calculateEarnings(tlConsumed) {
    // 1 TL 소비 = 100원 수익 (예시)
    return tlConsumed * 100;
  }

  async distributeEarnings(asset, earnings) {
    const copyrightEarnings = earnings * 0.5; // 50%
    const uploaderEarnings = earnings * 0.2; // 20%
    const platformEarnings = earnings * 0.3; // 30%
    
    // 실제 배분 로직 (여기서는 로깅만)
    await this.logActivity('earnings_distributed', {
      assetId: asset.id,
      copyrightEarnings,
      uploaderEarnings, 
      platformEarnings,
      timestamp: new Date().toISOString()
    });
    
    return { copyrightEarnings, uploaderEarnings, platformEarnings };
  }

  async logTransaction(txData) {
    const txId = `TX_${Date.now()}`;
    const transaction = {
      id: txId,
      ...txData,
      timestamp: new Date().toISOString()
    };
    
    await this.TRANSACTIONS.put(txId, JSON.stringify(transaction));
    return transaction;
  }

  async logActivity(type, data) {
    const logId = `LOG_${Date.now()}`;
    const logEntry = {
      type,
      ...data,
      timestamp: new Date().toISOString()
    };
    
    await this.TIME_DATA.put(logId, JSON.stringify(logEntry));
    return logEntry;
  }

  async updateTLStats(amount) {
    // API_CONFIG에 TL 통계 업데이트
    const statsKey = 'tl_statistics';
    let stats = await this.API_CONFIG.get(statsKey, { type: 'json' }) || {
      totalCharged: 0,
      totalConsumed: 0,
      totalEarnings: 0,
      updatedAt: new Date().toISOString()
    };
    
    stats.totalCharged += amount;
    stats.updatedAt = new Date().toISOString();
    
    await this.API_CONFIG.put(statsKey, JSON.stringify(stats));
    return stats;
  }

  // ========== 세션 관리 (기존 TL_SESSIONS 활용) ==========
  async createSession(email, userAgent = '') {
    const sessionId = `SESS_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const user = await this.getTimeLinkUser(email);
    
    if (!user) {
      throw new Error('사용자를 찾을 수 없습니다');
    }
    
    const session = {
      userId: user.id || email,
      userEmail: email,
      userAgent,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    };
    
    await this.SESSIONS.put(sessionId, JSON.stringify(session));
    return { sessionId, ...session };
  }

  async validateSession(sessionId) {
    const session = await this.SESSIONS.get(sessionId, { type: 'json' });
    
    if (!session) {
      return { valid: false, reason: '세션 없음' };
    }
    
    const now = new Date();
    const expiresAt = new Date(session.expiresAt);
    
    if (now > expiresAt) {
      await this.SESSIONS.delete(sessionId);
      return { valid: false, reason: '세션 만료' };
    }
    
    return { valid: true, session };
  }
}

// 싱글톤 인스턴스
let hybridManagerInstance = null;

export function getHybridManager(env) {
  if (!hybridManagerInstance) {
    hybridManagerInstance = new HybridManager(env);
  }
  return hybridManagerInstance;
}
