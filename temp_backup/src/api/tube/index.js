import { Router } from 'itty-router';

const router = Router();

// 기본 라우트
router.get('/', async (request, env, ctx) => {
  return new Response(
    JSON.stringify({ 
      endpoint: '/api/tube',
      message: 'tube API endpoint',
      methods: ['GET', 'POST', 'PUT', 'DELETE']
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
});

export default router;
