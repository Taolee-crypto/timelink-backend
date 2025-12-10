// 가장 간단한 버전
export default {
    fetch(request, env, ctx) {
        console.log('Request received:', request.url);
        return new Response(
            JSON.stringify({ message: 'Timelink API Working' }),
            {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            }
        );
    }
};
