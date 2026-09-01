const fs = require('fs');
const https = require('https');
const path = require('path');

/**
 * Download a file from a URL to a destination path.
 */
async function downloadFile(url, dest) {
    const dir = path.dirname(dest);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    return new Promise((resolve, reject) => {
        // Handle both http and https if needed, but Gemini is https
        const protocol = url.startsWith('https') ? https : require('http');
        
        protocol.get(url, (res) => {
            if (res.statusCode !== 200) {
                // Handle redirects (Gemini often uses them for images)
                if (res.statusCode === 301 || res.statusCode === 302) {
                    return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
                }
                reject(new Error(`下載失敗，狀態碼: ${res.statusCode}`));
                return;
            }
            const fileStream = fs.createWriteStream(dest);
            res.pipe(fileStream);
            fileStream.on('finish', () => {
                fileStream.close();
                resolve(dest);
            });
            fileStream.on('error', (err) => {
                fs.unlink(dest, () => reject(err));
            });
        }).on('error', reject);
    });
}

/**
 * Get the local IPv4 address of the machine.
 */
function getLocalIp() {
    const os = require('os');
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

module.exports = {
    downloadFile,
    getLocalIp
};
