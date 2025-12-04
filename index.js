export default {
  async fetch(request, env, ctx) {
    // CORS 설정
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, DELETE',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
      'Access-Control-Max-Age': '86400',
    };

    // Preflight 요청 처리
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // API 엔드포인트
    if (path === '/api/health' || path === '/api/health/') {
      return new Response(
        JSON.stringify({
          status: 'ok',
          service: 'timelink-api-worker',
          timestamp: new Date().toISOString(),
          environment: 'development'
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        }
      );
    }

    if (path === '/api/uuid' || path === '/api/uuid/') {
      return new Response(
        JSON.stringify({
          success: true,
          uuid: crypto.randomUUID(),
          timestamp: new Date().toISOString()
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        }
      );
    }

    if (path === '/api/message' || path === '/api/message/') {
      return new Response(
        JSON.stringify({
          message: 'Hello from TimeLink API!',
          timestamp: new Date().toISOString()
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        }
      );
    }

    // 루트 경로 - 정보 페이지
    if (path === '/' || path === '/index.html') {
      const html = `<!DOCTYPE html>
<html>
<head>
    <title>TimeLink API Worker</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            max-width: 800px;
            margin: 0 auto;
            padding: 40px 20px;
            line-height: 1.6;
            color: #333;
        }
        h1 { color: #1a237e; }
        .api-test {
            background: #f5f7ff;
            padding: 20px;
            border-radius: 10px;
            margin: 20px 0;
            border-left: 4px solid #536dfe;
        }
        button {
            background: #536dfe;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 5px;
            cursor: pointer;
            font-size: 16px;
            margin: 10px 5px;
        }
        button:hover {
            background: #3d5afe;
        }
        pre {
            background: #f8f9fa;
            padding: 15px;
            border-radius: 5px;
            overflow-x: auto;
            border: 1px solid #e9ecef;
        }
        .endpoint {
            background: #e8f5e9;
            padding: 10px;
            border-radius: 5px;
            margin: 10px 0;
            font-family: monospace;
        }
    </style>
</head>
<body>
    <h1>⚡ TimeLink API Worker</h1>
    <p>This worker handles API requests for the TimeLink platform.</p>
    
    <h2>Available API Endpoints:</h2>
    <div class="endpoint">GET <a href="/api/uuid">/api/uuid</a> - Generate a UUID</div>
    <div class="endpoint">GET <a href="/api/health">/api/health</a> - Health check</div>
    <div class="endpoint">GET <a href="/api/message">/api/message</a> - Test message</div>
    
    <div class="api-test">
        <h3>API 테스트</h3>
        <button onclick="testAPI('uuid')">Test UUID Endpoint</button>
        <button onclick="testAPI('health')">Test Health Check</button>
        <button onclick="testAPI('message')">Test Message</button>
        <pre id="result">Click a button to test API...</pre>
    </div>
    
    <script>
        async function testAPI(endpoint) {
            const resultEl = document.getElementById('result');
            resultEl.textContent = 'Testing...';
            
            try {
                const response = await fetch('/api/' + endpoint);
                const data = await response.json();
                resultEl.textContent = JSON.stringify(data, null, 2);
            } catch (error) {
                resultEl.textContent = 'Error: ' + error.message;
            }
        }
    </script>
</body>
</html>`;

      return new Response(html, {
        headers: {
          'Content-Type': 'text/html;charset=UTF-8',
          ...corsHeaders
        }
      });
    }

    // 404 처리
    return new Response(
      JSON.stringify({
        error: 'Not found',
        path: path,
        available_endpoints: ['/api/health', '/api/uuid', '/api/message']
      }),
      {
        status: 404,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      }
    );
  }
};
