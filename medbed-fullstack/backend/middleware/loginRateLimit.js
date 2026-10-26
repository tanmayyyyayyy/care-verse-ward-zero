const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 8;
const attempts = new Map();

const loginRateLimit = (req, res, next) => {
  const key = `${req.ip}:${String(req.body?.email || '').toLowerCase()}`;
  const now = Date.now();
  const entry = attempts.get(key);

  if (entry && entry.resetAt > now && entry.failures >= MAX_FAILURES) {
    return res.status(429).json({
      success: false,
      message: 'Too many failed login attempts. Try again in 15 minutes.',
    });
  }

  res.on('finish', () => {
    if (res.statusCode === 200) {
      attempts.delete(key);
      return;
    }
    if (res.statusCode !== 401) return;

    const current = attempts.get(key);
    if (!current || current.resetAt <= now) {
      attempts.set(key, { failures: 1, resetAt: now + WINDOW_MS });
    } else {
      current.failures += 1;
    }
  });

  next();
};

module.exports = { loginRateLimit };
