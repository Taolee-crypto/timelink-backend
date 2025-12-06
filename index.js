// timelink-backend/src/index.ts
import { Router } from 'itty-router';
import { corsMiddleware } from './middleware/cors';
import { authMiddleware } from './middleware/auth';
import { errorHandler } from './middleware/error';

// API 라우터들
import authRoutes from './api/auth';
import userRoutes from './api/user';
import contentRoutes from './api/content';
import studioRoutes from './api/studio';
import marketRoutes from './api/market';
import tubeRoutes from './api/tube';
import copyrightRoutes from './api/copyright';
import paymentRoutes from './api/payment';
import adminRoutes from './api/admin';

const router = Router();

// 미들웨어 적용
router.all('*', corsMiddleware);

// 헬스 체크
router.get('/api/health', () => new Response(JSON.stringify({ 
  status: 'healthy', 
  timestamp: new Date().toISOString() 
}), { status: 200 }));

// API 라우트 등록
router.all('/api/auth/*', authRoutes.handle);
router.all('/api/user/*', authMiddleware, userRoutes.handle);
router.all('/api/content/*', authMiddleware, contentRoutes.handle);
router.all('/api/studio/*', authMiddleware, studioRoutes.handle);
router.all('/api/market/*', authMiddleware, marketRoutes.handle);
router.all('/api/tube/*', authMiddleware, tubeRoutes.handle);
router.all('/api/copyright/*', authMiddleware, copyrightRoutes.handle);
router.all('/api/payment/*', authMiddleware, paymentRoutes.handle);
router.all('/api/admin/*', authMiddleware, adminRoutes.handle);

// 404 처리
router.all('*', () => new Response(JSON.stringify({ 
  error: 'Not Found',
  message: 'The requested resource was not found' 
}), { status: 404 }));

// 에러 처리
router.all('*', errorHandler);

export default {
  fetch: router.handle
};
