const http = require('http');

const data = JSON.stringify({
    query: "antalya ges firma",
    maxResults: 7
});

const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/scrape',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
    }
};

const req = http.request(options, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
        console.log('Response:');
        console.log(JSON.stringify(JSON.parse(body), null, 2));
    });
});

req.on('error', (e) => {
    console.error('Error:', e.message);
});

req.write(data);
req.end();
