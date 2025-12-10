import('./src/index.js').then(module => {
    const handler = module.default;
    const request = new Request('http://localhost/health');
    
    handler.fetch(request).then(response => {
        console.log('✅ Success! Response:', response.status);
        return response.text();
    }).then(text => {
        console.log('Response body:', text);
    }).catch(error => {
        console.error('❌ Error:', error);
    });
});
