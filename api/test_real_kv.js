const https = require('https');

function kvFetch(url, options = {}) {
    return new Promise((resolve, reject) => {
        try {
            const urlObj = new URL(url);
            const reqOptions = {
                hostname: urlObj.hostname,
                path: urlObj.pathname + urlObj.search,
                method: options.method || 'GET',
                headers: options.headers || {}
            };
            
            const timeout = options.timeout || 8000;
            
            const req = https.request(reqOptions, (res) => {
                let data = '';
                res.on('data', (chunk) => {
                    data += chunk;
                });
                res.on('end', () => {
                    resolve({
                        ok: res.statusCode >= 200 && res.statusCode < 300,
                        status: res.statusCode,
                        text: () => Promise.resolve(data)
                    });
                });
            });
            
            req.on('error', (err) => {
                reject(err);
            });
            
            req.setTimeout(timeout, () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });
            
            if (options.body) {
                req.write(options.body);
            }
            req.end();
        } catch (err) {
            reject(err);
        }
    });
}

async function test() {
    const appKey = "econ_dash_ronshenkman_active_series_v2";
    const key = "active_series";
    const testData = JSON.stringify([{ code: "RER_USD_ILS", range: "5y" }]);
    const hexData = Buffer.from(testData, 'utf8').toString('hex');
    
    try {
        console.log("1. Reading current value from KV...");
        const getUrl = `https://keyvalue.immanuel.co/api/KeyVal/GetValue/${appKey}/${key}`;
        const resGet = await kvFetch(getUrl);
        console.log("GET status:", resGet.status);
        const textGet = await resGet.text();
        console.log("GET body:", textGet);
        
        console.log("\n2. Writing test value to KV...");
        const updateUrl = `https://keyvalue.immanuel.co/api/KeyVal/UpdateValue/${appKey}/${key}/${hexData}`;
        const resUpdate = await kvFetch(updateUrl, { method: 'POST' });
        console.log("POST status:", resUpdate.status);
        const textUpdate = await resUpdate.text();
        console.log("POST body:", textUpdate);
        
    } catch (err) {
        console.error("Error:", err);
    }
}

test();
