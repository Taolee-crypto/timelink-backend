// test-cors.js
export default {
    async fetch(request) {
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        };
        
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }
        
        return new Response(
            JSON.stringify({ message: 'OK' }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    }
};
