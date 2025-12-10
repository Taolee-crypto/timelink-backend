// test.js
const handler = {
    async fetch(request, env, ctx) {
        return new Response('Hello Timelink');
    }
};

// 테스트
const mockRequest = new Request('http://localhost/');
handler.fetch(mockRequest).then(response => {
    console.log('Response status:', response.status);
    console.log('Response ok:', response.ok);
}).catch(error => {
    console.error('Error:', error);
});
