import { Router } from 'itty-router';
import loginHandler from './login.js';
import registerHandler from './register.js';
import logoutHandler from './logout.js';
import refreshHandler from './refresh.js';
import socialAuthHandler from './social-auth.js';

const router = Router();

router.post('/api/auth/login', loginHandler);
router.post('/api/auth/register', registerHandler);
router.post('/api/auth/logout', logoutHandler);
router.post('/api/auth/refresh', refreshHandler);
router.post('/api/auth/social', socialAuthHandler);

export default router;
