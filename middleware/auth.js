const jwt = require('jsonwebtoken');

const authMiddleware = {
  verifyToken: (req, res, next) => {
    // 임시 인증 (개발용)
    if (process.env.NODE_ENV === 'development') {
      req.user = {
        id: 'dev_user_id',
        address: '0x0000000000000000000000000000000000000000'
      };
      return next();
    }

    const token = req.headers.authorization?.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ error: 'Access token required' });
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'timelink_dev_secret');
      req.user = decoded;
      next();
    } catch (error) {
      return res.status(401).json({ error: 'Invalid token' });
    }
  },

  verifyAdmin: (req, res, next) => {
    if (req.user && req.user.role === 'admin') {
      next();
    } else {
      res.status(403).json({ error: 'Admin access required' });
    }
  },

  verifyWallet: (req, res, next) => {
    const walletAddress = req.headers['x-wallet-address'];
    const signature = req.headers['x-signature'];
    
    if (!walletAddress || !signature) {
      return res.status(401).json({ error: 'Wallet authentication required' });
    }
    
    // TODO: 서명 검증 로직 구현
    req.user = {
      address: walletAddress,
      verified: true
    };
    next();
  }
};

module.exports = authMiddleware;
