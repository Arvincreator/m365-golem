const { chromium } = require('playwright');
const { execSync } = require('child_process');

async function main() {
    console.log("Launching browser...");
    const browser = await chromium.launch({ headless: false });
    const page = await browser.newPage();
    await page.goto('https://example.com');
    
    // Wait for it to be active
    await new Promise(r => setTimeout(r, 1000));
    
    try {
        const activeApp = execSync(`osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`).toString().trim();
        console.log("PLAYWRIGHT ACTIVE APP IS:", activeApp);
    } catch (e) {
        console.error("Error:", e);
    }
    
    await browser.close();
}

main();
