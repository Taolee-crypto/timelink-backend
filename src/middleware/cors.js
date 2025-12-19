// CORS 미들웨어
export const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true'
};

export function handleCors(request) {
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            headers: corsHeaders
        });
    }
    return null;
}

export function addCorsHeaders(response) {
    const newHeaders = new Headers(response.headers);
    Object.entries(corsHeaders).forEach(([key, value]) => {
        newHeaders.set(key, value);
    });
    return new Response(response.body, {
        status: response.status,
        headers: newHeaders
    });
}
