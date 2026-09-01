const { chromium } = require('playwright');

async function main() {
    console.log("Launching headless browser...");
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded' });
        console.log("Successfully loaded Gemini in Headless Mode");
        const title = await page.title();
        console.log("Page title:", title);
    } catch(e) {
        console.error("Error in headless:", e);
    }
    await browser.close();
}

main();
