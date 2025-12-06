const rateLimitMap = new Map();

export function rateLimitMiddleware(request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const maxRequests = 100;
  
  const userRequests = rateLimitMap.get(ip) || [];
  const recentRequests = userRequests.filter(time => now - time < windowMs);
  
  if (recentRequests.length >= maxRequests) {
    return new Response(
      JSON.stringify({ error: 'Too many requests, please try again later.' }),
      { 
        status: 429,
        headers: { 
          'Content-Type': 'application/json',
          'Retry-After': Math.ceil(windowMs / 1000)
        }
      }
    );
  }
  
  recentRequests.push(now);
  rateLimitMap.set(ip, recentRequests);
  
  return;
}
