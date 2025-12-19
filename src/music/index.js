// $musicFile - Music API 서버
import { Router } from 'itty-router';

const router = Router();

// CORS 헤더
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-User-Id',
};

// OPTIONS 요청 처리
router.options('*', () => new Response(null, { headers: corsHeaders }));

// 음악 파일 목록 조회
router.get('/api/music/files', async (request, env) => {
  try {
    const userId = request.headers.get('X-User-Id');
    if (!userId) {
      return new Response(JSON.stringify({ error: 'User ID required' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const userFiles = await env.MUSIC_METADATA.get(`user:\${userId}:files`, { type: 'json' }) || [];
    
    return new Response(JSON.stringify({ files: userFiles }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
});

// 음악 파일 업로드
router.post('/api/music/upload', async (request, env) => {
  try {
    const userId = request.headers.get('X-User-Id');
    if (!userId) {
      return new Response(JSON.stringify({ error: 'User ID required' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const formData = await request.formData();
    const file = formData.get('file');
    const metadata = JSON.parse(formData.get('metadata') || '{}');

    if (!file) {
      return new Response(JSON.stringify({ error: 'No file provided' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const fileId = `music_\${Date.now()}_\${Math.random().toString(36).substr(2, 9)}`;
    const fileName = `\${fileId}.\${getFileExtension(file.name)}`;
    
    await env.MUSIC_BUCKET.put(fileName, file.stream(), {
      httpMetadata: { contentType: file.type },
      customMetadata: {
        originalName: file.name,
        userId,
        uploadedAt: new Date().toISOString(),
        duration: metadata.duration || 0,
        tlFormat: metadata.format || 'tl3',
        multiplier: metadata.multiplier || 1,
        chargeAmount: 0,
        maxCharge: metadata.duration || 0,
      },
    });

    const fileData = {
      id: fileId,
      name: fileName,
      originalName: file.name,
      userId,
      size: file.size,
      type: file.type,
      duration: metadata.duration || 0,
      format: metadata.format || 'tl3',
      multiplier: metadata.multiplier || 1,
      chargeAmount: 0,
      maxCharge: metadata.duration || 0,
      createdAt: new Date().toISOString(),
      url: `/api/music/file/\${fileId}`,
      playUrl: `/api/music/play/\${fileId}`,
    };

    await env.MUSIC_METADATA.put(`file:\${fileId}`, JSON.stringify(fileData));
    
    const userFiles = await env.MUSIC_METADATA.get(`user:\${userId}:files`, { type: 'json' }) || [];
    userFiles.push({
      id: fileId,
      name: fileData.originalName,
      url: fileData.url,
      duration: fileData.duration,
      format: fileData.format,
      createdAt: fileData.createdAt,
      chargeAmount: fileData.chargeAmount,
      maxCharge: fileData.maxCharge,
    });
    await env.MUSIC_METADATA.put(`user:\${userId}:files`, JSON.stringify(userFiles));

    return new Response(JSON.stringify({
      success: true,
      file: fileData,
      message: 'File uploaded successfully'
    }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
});

// 음악 파일 재생
router.get('/api/music/play/:fileId', async (request, env) => {
  try {
    const { fileId } = request.params;
    if (!fileId) {
      return new Response(JSON.stringify({ error: 'File ID required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const fileData = await env.MUSIC_METADATA.get(`file:\${fileId}`, { type: 'json' });
    if (!fileData) {
      return new Response(JSON.stringify({ error: 'File not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const object = await env.MUSIC_BUCKET.get(fileData.name);
    if (!object) {
      return new Response(JSON.stringify({ error: 'File not found in storage' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Cache-Control', 'public, max-age=31536000');
    
    return new Response(object.body, { headers });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
});

// 음악 파일 메타데이터
router.get('/api/music/file/:fileId', async (request, env) => {
  try {
    const { fileId } = request.params;
    const metadata = await env.MUSIC_METADATA.get(`file:\${fileId}`, { type: 'json' });
    
    if (!metadata) {
      return new Response(JSON.stringify({ error: 'File not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    return new Response(JSON.stringify(metadata), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
});

// 음악 파일 충전
router.post('/api/music/charge/:fileId', async (request, env) => {
  try {
    const { fileId } = request.params;
    const { amount, userId } = await request.json();
    
    if (!fileId || !amount || !userId) {
      return new Response(JSON.stringify({ error: 'Missing parameters' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const fileData = await env.MUSIC_METADATA.get(`file:\${fileId}`, { type: 'json' });
    if (!fileData) {
      return new Response(JSON.stringify({ error: 'File not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const newChargeAmount = Math.min(fileData.chargeAmount + amount, fileData.maxCharge);
    fileData.chargeAmount = newChargeAmount;
    
    await env.MUSIC_METADATA.put(`file:\${fileId}`, JSON.stringify(fileData));

    const userFiles = await env.MUSIC_METADATA.get(`user:\${userId}:files`, { type: 'json' }) || [];
    const updatedFiles = userFiles.map(file => 
      file.id === fileId ? { ...file, chargeAmount: newChargeAmount } : file
    );
    await env.MUSIC_METADATA.put(`user:\${userId}:files`, JSON.stringify(updatedFiles));

    return new Response(JSON.stringify({
      success: true,
      fileId,
      chargeAmount: newChargeAmount,
      message: 'File charged successfully'
    }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
});

function getFileExtension(filename) {
  return filename.slice((filename.lastIndexOf(".") - 1 >>> 0) + 2);
}

export default router;
