const mongoose = require('mongoose');

const connectDatabase = async () => {
  try {
    const mongoURI = process.env.MONGODB_URI || 'mongodb://localhost:27017/timelink';
    
    const connectionOptions = {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      maxPoolSize: 10,
      minPoolSize: 2,
      retryWrites: true,
      w: 'majority'
    };

    await mongoose.connect(mongoURI, connectionOptions);
    
    console.log(`✅ MongoDB connected: ${mongoose.connection.host}`);
    
    // 연결 이벤트 리스너
    mongoose.connection.on('connected', () => {
      console.log('Mongoose connected to DB');
    });
    
    mongoose.connection.on('error', (err) => {
      console.error(`Mongoose connection error: ${err}`);
    });
    
    mongoose.connection.on('disconnected', () => {
      console.warn('Mongoose disconnected from DB');
    });
    
    // 앱 종료 시 연결 종료
    process.on('SIGINT', async () => {
      await mongoose.connection.close();
      console.log('Mongoose connection closed due to app termination');
      process.exit(0);
    });

    return mongoose.connection;

  } catch (error) {
    console.error(`MongoDB connection failed: ${error.message}`);
    
    // 재시도 로직
    if (process.env.NODE_ENV === 'production') {
      setTimeout(connectDatabase, 5000); // 5초 후 재시도
    } else {
      throw error;
    }
  }
};

// 인덱스 생성 함수
const ensureIndexes = async () => {
  try {
    const models = mongoose.modelNames();
    console.log(`Creating indexes for ${models.length} models...`);
    
    // 각 모델의 인덱스 생성
    for (const modelName of models) {
      const model = mongoose.model(modelName);
      await model.createIndexes();
    }
    
    console.log('✅ All indexes created successfully');
  } catch (error) {
    console.error(`Index creation failed: ${error.message}`);
  }
};

// 데이터베이스 상태 확인
const checkDatabaseHealth = async () => {
  try {
    const adminDb = mongoose.connection.db.admin();
    const status = await adminDb.serverStatus();
    
    return {
      healthy: true,
      uptime: status.uptime,
      connections: status.connections,
      memory: status.mem,
      network: status.network,
      storage: await getStorageStats()
    };
  } catch (error) {
    return {
      healthy: false,
      error: error.message
    };
  }
};

// 스토리지 통계
const getStorageStats = async () => {
  try {
    const stats = await mongoose.connection.db.stats();
    
    return {
      db: stats.db,
      collections: stats.collections,
      objects: stats.objects,
      avgObjSize: stats.avgObjSize,
      dataSize: stats.dataSize,
      storageSize: stats.storageSize,
      indexes: stats.indexes,
      indexSize: stats.indexSize,
      fileSize: stats.fileSize
    };
  } catch (error) {
    return { error: error.message };
  }
};

// 백업 함수 (개념적)
const backupDatabase = async (backupPath = './backups') => {
  console.log(`Starting database backup to ${backupPath}`);
  
  // 실제 구현에서는 mongodump 사용
  // 여기서는 로그만 출력
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = `${backupPath}/timelink-backup-${timestamp}.json`;
  
  console.log(`Backup would be saved to: ${backupFile}`);
  
  return {
    success: true,
    message: 'Backup scheduled',
    backupFile,
    timestamp
  };
};

module.exports = {
  connectDatabase,
  ensureIndexes,
  checkDatabaseHealth,
  backupDatabase,
  getStorageStats
};
