const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-task-board-jwt-key';

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'] || req.headers['x-auth-token'];
  if (!authHeader) {
    return res.status(401).json({ error: 'Authentication token required' });
  }

  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || req.headers['x-auth-token'];
  if (authHeader) {
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    try {
      req.user = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      // Ignore token verification errors for optional auth
    }
  }
  return next();
}

function generateToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

module.exports = {
  JWT_SECRET,
  authenticateToken,
  optionalAuth,
  generateToken,
};
