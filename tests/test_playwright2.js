const { chromium } = require('playwright');
const { execSync } = require('child_process');

async function main() {
    console.log("Launching browser...");
    const browser = await chromium.launch({ headless: false });
    const page = await browser.newPage();
    await page.goto('https://example.com');
    await new Promise(r => setTimeout(r, 1000));
    
    // Focus the page! This steals focus from Terminal/VSCode
    console.log("Focusing input...");
    await page.focus('body');
    await new Promise(r => setTimeout(r, 1000));
    
    // Now hide Chrome!
    console.log("Hiding Chrome...");
    try {
        execSync(`osascript -e 'tell application "System Events" to set visible of process "Google Chrome for Testing" to false'`);
        execSync(`osascript -e 'tell application "System Events" to set visible of process "Google Chrome" to false'`);
    } catch(e) {}
    
    // Wait for 2 seconds so we can observe if focus returned to Terminal
    await new Promise(r => setTimeout(r, 2000));
    
    try {
        const activeApp = execSync(`osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`).toString().trim();
        console.log("Active app after hiding Chrome is:", activeApp);
    } catch (e) {
    }
    
    await browser.close();
}

main();
