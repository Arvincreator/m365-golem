const { chromium } = require('playwright');
const { execSync } = require('child_process');

async function main() {
    console.log("Launching browser...");
    const browser = await chromium.launch({ headless: false });
    const page = await browser.newPage();
    await page.goto('https://example.com');
    await new Promise(r => setTimeout(r, 1000));
    
    // Hide Chrome first
    console.log("Hiding Chrome...");
    try {
        execSync(`osascript -e 'tell application "System Events" to set visible of process "Google Chrome for Testing" to false'`);
    } catch(e) {}
    
    await new Promise(r => setTimeout(r, 1000));
    
    // Focus the page! Does it unhide and steal focus from Terminal?
    console.log("Focusing input while hidden...");
    await page.focus('body');
    
    // Type something
    await page.keyboard.type("Hello world");
    
    await new Promise(r => setTimeout(r, 2000));
    
    try {
        const activeApp = execSync(`osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`).toString().trim();
        console.log("Active app after typing while hidden is:", activeApp);
    } catch (e) {}
    
    await browser.close();
}

main();
