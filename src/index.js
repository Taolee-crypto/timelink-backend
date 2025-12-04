import { Router } from 'itty-router';
import { handleCors, withAuth } from './middleware/cors.js';
import authRoutes from './api/auth/index.js';
import userRoutes from './api/user/index.js';
import contentRoutes from './api/content/index.js';

const router = Router();

// CORS 미들웨어
router.all('*', handleCors);

// Health check
router.get('/api/health', () => {
  return new Response(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }), {
    headers: { 'Content-Type': 'application/json' }
  });
});

// 인증 API
router.post('/api/auth/login', authRoutes.login);
router.post('/api/auth/register', authRoutes.register);
router.get('/api/auth/verify', authRoutes.verify);

// 사용자 API (인증 필요)
router.get('/api/user/profile', withAuth, userRoutes.profile);
router.put('/api/user/profile', withAuth, userRoutes.updateProfile);

// 콘텐츠 API
router.post('/api/content/upload', withAuth, contentRoutes.upload);
router.get('/api/content/list', contentRoutes.list);
router.get('/api/content/:id', contentRoutes.get);

// 404 처리
router.all('*', () => new Response('Not Found', { status: 404 }));

export default {
  fetch: router.handle
};
