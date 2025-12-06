export default async function uploadHandler(request, env, ctx) {
  try {
    const userId = request.user.id;
    
    // Content-Type 확인
    const contentType = request.headers.get('Content-Type') || '';
    
    if (!contentType.includes('multipart/form-data')) {
      return new Response(
        JSON.stringify({ error: 'Content-Type must be multipart/form-data' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    
    // 실제 파일 업로드 로직은 여기에 구현
    // Cloudflare R2나 다른 스토리지 서비스 사용
    
    return new Response(
      JSON.stringify({ 
        success: true, 
        message: 'Upload endpoint (implementation needed)',
        userId 
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
    
  } catch (error) {
    console.error('Upload error:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
