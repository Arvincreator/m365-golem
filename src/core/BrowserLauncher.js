// ============================================================
// 🚀 BrowserLauncher - Playwright (Chromium) 啟動 / 連線管理
// ============================================================
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { BROWSER_ARGS, LOCK_FILES, LIMITS, TIMINGS } = require('./constants');

const DEFAULT_VIEWPORTS = Object.freeze([
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1536, height: 864 },
    { width: 1600, height: 900 },
]);

function parseBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return fallback;
}

function parseInteger(value, fallback) {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? Math.floor(num) : fallback;
}

function parseFloatNumber(value, fallback) {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? num : fallback;
}

function pickRandom(items) {
    if (!Array.isArray(items) || items.length === 0) return null;
    return items[Math.floor(Math.random() * items.length)];
}

function getDefaultNavigatorPlatform() {
    if (process.platform === 'darwin') return 'MacIntel';
    if (process.platform === 'win32') return 'Win32';
    return 'Linux x86_64';
}

function getDefaultUserAgent(navigatorPlatform) {
    const chromeMajor = String(process.env.PLAYWRIGHT_STEALTH_CHROME_MAJOR || '141').trim() || '141';
    if (navigatorPlatform === 'MacIntel') {
        return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`;
    }
    if (navigatorPlatform === 'Win32') {
        return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`;
    }
    return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`;
}

function buildStealthProfile() {
    const languagesRaw = String(process.env.PLAYWRIGHT_STEALTH_LANGUAGES || 'zh-TW,zh,en-US,en');
    const languages = languagesRaw
        .split(',')
        .map((x) => x.trim())
        .filter((x) => x);

    const localeRaw = String(process.env.PLAYWRIGHT_STEALTH_LOCALE || '').trim();
    const locale = localeRaw || languages[0] || 'zh-TW';

    const timezoneId = String(process.env.PLAYWRIGHT_STEALTH_TIMEZONE || process.env.TZ || 'Asia/Taipei').trim();
    const navigatorPlatform = String(process.env.PLAYWRIGHT_STEALTH_PLATFORM || getDefaultNavigatorPlatform()).trim();
    const userAgent = String(
        process.env.PLAYWRIGHT_STEALTH_USER_AGENT || getDefaultUserAgent(navigatorPlatform)
    ).trim();

    return {
        locale,
        timezoneId,
        userAgent,
        languages,
        navigatorPlatform,
        hardwareConcurrency: parseInteger(process.env.PLAYWRIGHT_STEALTH_HARDWARE_CONCURRENCY, 8),
        deviceMemory: parseFloatNumber(process.env.PLAYWRIGHT_STEALTH_DEVICE_MEMORY, 8),
        webglVendor: String(process.env.PLAYWRIGHT_STEALTH_WEBGL_VENDOR || 'Intel Inc.').trim(),
        webglRenderer: String(process.env.PLAYWRIGHT_STEALTH_WEBGL_RENDERER || 'Intel Iris OpenGL Engine').trim(),
    };
}

function buildAcceptLanguageHeader(languages) {
    if (!Array.isArray(languages) || languages.length === 0) {
        return 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7';
    }
    return languages
        .map((lang, index) => {
            if (index === 0) return lang;
            const quality = Math.max(0.4, 1 - (index * 0.1)).toFixed(1);
            return `${lang};q=${quality}`;
        })
        .join(',');
}

function resolveViewport() {
    const custom = String(process.env.PLAYWRIGHT_STEALTH_VIEWPORT || '').trim();
    const customMatch = custom.match(/^(\d{3,5})[xX](\d{3,5})$/);
    if (customMatch) {
        return { width: Number(customMatch[1]), height: Number(customMatch[2]) };
    }

    const randomize = parseBoolean(process.env.PLAYWRIGHT_STEALTH_RANDOM_VIEWPORT, true);
    if (!randomize) return { ...DEFAULT_VIEWPORTS[0] };
    return { ...pickRandom(DEFAULT_VIEWPORTS) };
}

class BrowserLauncher {
    /**
     * 統一入口：根據環境自動選擇連線或啟動瀏覽器
     * @param {Object} options
     * @param {string} options.userDataDir - 瀏覽器使用者資料目錄
     * @param {string} [options.headless] - 無頭模式設定 ('true' | 'new' | falsy)
     * @param {Object} [options.browserPolicy] - 後端專用瀏覽器策略
     * @returns {Promise<import('playwright').BrowserContext>}
     */
    static async launch({ userDataDir, headless, browserPolicy = {} }) {
        const isDocker = fs.existsSync('/.dockerenv');
        const remoteDebugPort = process.env.PLAYWRIGHT_REMOTE_DEBUGGING_PORT;

        if (isDocker && remoteDebugPort) {
            return BrowserLauncher.connectRemote('host.docker.internal', remoteDebugPort);
        }
        return BrowserLauncher.launchLocal(userDataDir, headless, LIMITS.MAX_BROWSER_RETRY, browserPolicy);
    }

    /**
     * Docker 環境下，透過 Remote Debugging Protocol 連線到宿主機 Chrome
     * @param {string} host - 宿主機主機名
     * @param {string|number} port - Debugging 埠號
     * @returns {Promise<import('playwright').Browser>}
     */
    static async connectRemote(host, port) {
        const browserURL = `http://${host}:${port}`;
        console.log(`🔌 [System] Connecting to Remote Chrome via CDP at ${browserURL}...`);

        const wsEndpoint = await new Promise((resolve, reject) => {
            const req = http.get(
                `http://${host}:${port}/json/version`,
                { headers: { 'Host': 'localhost' } },
                (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        try {
                            const json = JSON.parse(data);
                            const wsUrl = new URL(json.webSocketDebuggerUrl);
                            wsUrl.host = host;
                            wsUrl.port = port;
                            resolve(wsUrl.toString());
                        } catch (e) {
                            reject(new Error(`Failed to parse /json/version: ${data}`));
                        }
                    });
                }
            );
            req.on('error', reject);
            req.setTimeout(TIMINGS.CDP_TIMEOUT, () => {
                req.destroy();
                reject(new Error('Timeout fetching /json/version'));
            });
        });

        const browser = await chromium.connectOverCDP(wsEndpoint);
        console.log(`✅ [System] Connected to Remote Chrome!`);
        return browser.contexts()[0];
    }

    /**
     * 本地環境啟動瀏覽器 (使用 launchPersistentContext 以符合原本的 userDataDir 行為)
     * @param {string} userDataDir - 使用者資料目錄
     * @param {string} [headless] - 無頭模式
     * @param {number} [retries] - 剩餘重試次數
     * @param {Object} [browserPolicy] - 後端專用瀏覽器策略
     * @returns {Promise<import('playwright').BrowserContext>}
     */
    static async launchLocal(userDataDir, headless, retries = LIMITS.MAX_BROWSER_RETRY, browserPolicy = {}) {
        const shouldCleanProfileLocks = browserPolicy.autoCleanProfileLocks !== false;
        if (shouldCleanProfileLocks) {
            BrowserLauncher.cleanLocks(userDataDir);
        } else {
            const existingLocks = BrowserLauncher.listExistingLocks(userDataDir);
            if (existingLocks.length > 0) {
                const lockError = new Error(`此 M365 瀏覽器設定檔目前正在使用中（${existingLocks.join(', ')}）；請只關閉同一個工作設定檔的 Edge 視窗後再重新啟動。為保護登入狀態，GOLEM 不會自動刪除或移動鎖定檔。`);
                lockError.code = 'BROWSER_PROFILE_IN_USE';
                lockError.lockFiles = existingLocks;
                throw lockError;
            }
        }

        try {
            const stealthEnvKey = browserPolicy.stealthEnvKey || 'PLAYWRIGHT_STEALTH_ENABLED';
            const stealthEnabled = parseBoolean(
                process.env[stealthEnvKey],
                browserPolicy.stealthDefault !== undefined ? browserPolicy.stealthDefault : true
            );
            const stealthProfile = buildStealthProfile();
            const viewport = resolveViewport();
            const excludedArgs = new Set(browserPolicy.excludedArgs || []);
            const launchArgs = BROWSER_ARGS.filter((arg) => !excludedArgs.has(arg));
            if (stealthEnabled && stealthProfile.locale) {
                launchArgs.push(`--lang=${stealthProfile.locale}`);
            }

            const contextOptions = {
                headless: browserPolicy.forceHeaded === true
                    ? false
                    : (headless === 'true' || headless === 'new'),
                viewport,
                args: launchArgs,
                ignoreDefaultArgs: Array.isArray(browserPolicy.ignoreDefaultArgs)
                    ? browserPolicy.ignoreDefaultArgs
                    : ['--enable-automation', '--disable-extensions'],
            };

            const channelEnvKey = browserPolicy.channelEnvKey || 'PLAYWRIGHT_BROWSER_CHANNEL';
            const fallbackChannel = browserPolicy.fallbackChannelEnvKey
                ? process.env[browserPolicy.fallbackChannelEnvKey]
                : '';
            const browserChannel = String(
                process.env[channelEnvKey] || fallbackChannel || browserPolicy.preferredChannel || ''
            ).trim();
            if (browserChannel) {
                contextOptions.channel = browserChannel;
            }

            if (stealthEnabled) {
                contextOptions.locale = stealthProfile.locale;
                contextOptions.timezoneId = stealthProfile.timezoneId;
                contextOptions.userAgent = stealthProfile.userAgent;
                contextOptions.extraHTTPHeaders = {
                    'Accept-Language': buildAcceptLanguageHeader(stealthProfile.languages),
                };
            }

            // Playwright 中，launchPersistentContext 直接回傳 Context，省去 browser.newPage() 的麻煩
            const context = await chromium.launchPersistentContext(userDataDir, contextOptions);

            if (stealthEnabled) {
                await BrowserLauncher.applyStealthHardening(context, stealthProfile);
                console.log(`🕵️ [System] Playwright stealth hardening enabled (${stealthProfile.locale}, ${viewport.width}x${viewport.height})`);
            }

            const blockHeavyResourcesEnvKey = browserPolicy.blockHeavyResourcesEnvKey || 'PLAYWRIGHT_BLOCK_HEAVY_RESOURCES';
            const blockHeavyResources = parseBoolean(
                process.env[blockHeavyResourcesEnvKey],
                browserPolicy.blockHeavyResourcesDefault !== undefined
                    ? browserPolicy.blockHeavyResourcesDefault
                    : true
            );
            if (blockHeavyResources) {
                // 🛡️ [Network Interception] 資源攔截優化 (大幅節省 RAM)
                try {
                    await context.route('**/*', (route) => {
                        const req = route.request();
                        const type = req.resourceType();
                        // 阻擋重量級視覺與字型資源
                        if (['image', 'media', 'font'].includes(type) && !req.url().includes('recaptcha')) {
                            return route.abort();
                        }
                        // 阻擋常見的第三方廣告/追蹤腳本
                        const url = req.url().toLowerCase();
                        if (url.includes('google-analytics') || url.includes('doubleclick') || url.includes('googletagmanager')) {
                            return route.abort();
                        }
                        return route.continue();
                    });
                    console.log(`🛡️ [System] 網路資源攔截已啟用 (封鎖 Image, Media, Font, trackers)`);
                } catch (routeErr) {
                    console.warn(`⚠️ [System] 網路攔截設定失敗: ${routeErr.message}`);
                }
            }

            return context;
        } catch (err) {
            const profileLocked = /profile appears to be in use|user data directory.*already in use|process singleton|singletonlock|opening in existing browser session/i.test(String(err && err.message || ''));
            if (profileLocked && !shouldCleanProfileLocks) {
                const lockError = new Error('此 M365 瀏覽器設定檔目前正在使用中；請先關閉同一個工作設定檔，再重新啟動。為保護登入狀態，GOLEM 不會自動刪除鎖定檔。');
                lockError.code = 'BROWSER_PROFILE_IN_USE';
                lockError.cause = err;
                throw lockError;
            }
            if (retries > 0 && profileLocked) {
                console.warn(`⚠️ [System] Profile locked. Retrying launch (${retries} left)...`);
                BrowserLauncher.cleanLocks(userDataDir);
                await new Promise(r => setTimeout(r, TIMINGS.BROWSER_RETRY_DELAY));
                return BrowserLauncher.launchLocal(userDataDir, headless, retries - 1, browserPolicy);
            }
            throw err;
        }
    }

    static async applyStealthHardening(context, stealthProfile) {
        await context.addInitScript((profile) => {
            const safeDefineGetter = (target, key, value) => {
                if (!target) return;
                try {
                    Object.defineProperty(target, key, {
                        get: () => value,
                        configurable: true,
                    });
                } catch (e) {
                    // Ignore define failures for locked properties
                }
            };

            const languages = Array.isArray(profile.languages) && profile.languages.length
                ? profile.languages
                : ['zh-TW', 'zh', 'en-US', 'en'];
            const primaryLanguage = languages[0] || 'zh-TW';
            const patchedUserAgent = String(profile.userAgent || navigator.userAgent || '')
                .replace(/HeadlessChrome\//g, 'Chrome/');

            safeDefineGetter(navigator, 'webdriver', undefined);
            safeDefineGetter(navigator, 'platform', profile.navigatorPlatform || navigator.platform);
            safeDefineGetter(navigator, 'languages', languages);
            safeDefineGetter(navigator, 'language', primaryLanguage);
            safeDefineGetter(navigator, 'vendor', 'Google Inc.');
            safeDefineGetter(navigator, 'hardwareConcurrency', Number(profile.hardwareConcurrency || 8));
            safeDefineGetter(navigator, 'deviceMemory', Number(profile.deviceMemory || 8));
            safeDefineGetter(navigator, 'userAgent', patchedUserAgent);

            const fakePlugins = [
                { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
                { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
            ];
            const fakeMimeTypes = [
                { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
            ];
            safeDefineGetter(navigator, 'plugins', fakePlugins);
            safeDefineGetter(navigator, 'mimeTypes', fakeMimeTypes);

            if (!window.chrome) {
                try {
                    Object.defineProperty(window, 'chrome', {
                        value: { runtime: {} },
                        configurable: true,
                    });
                } catch (e) {
                    // Ignore
                }
            }

            if (navigator.permissions && typeof navigator.permissions.query === 'function') {
                const originalQuery = navigator.permissions.query.bind(navigator.permissions);
                navigator.permissions.query = (parameters) => {
                    if (parameters && parameters.name === 'notifications') {
                        return Promise.resolve({ state: Notification.permission });
                    }
                    return originalQuery(parameters);
                };
            }

            const patchWebgl = (prototype) => {
                if (!prototype || typeof prototype.getParameter !== 'function') return;
                const originalGetParameter = prototype.getParameter;
                prototype.getParameter = function patchedGetParameter(parameter) {
                    if (parameter === 37445) return profile.webglVendor || 'Intel Inc.'; // UNMASKED_VENDOR_WEBGL
                    if (parameter === 37446) return profile.webglRenderer || 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
                    return originalGetParameter.call(this, parameter);
                };
            };

            if (typeof WebGLRenderingContext !== 'undefined') {
                patchWebgl(WebGLRenderingContext.prototype);
            }
            if (typeof WebGL2RenderingContext !== 'undefined') {
                patchWebgl(WebGL2RenderingContext.prototype);
            }

            if (typeof window.outerWidth === 'number' && window.outerWidth === 0) {
                safeDefineGetter(window, 'outerWidth', window.innerWidth);
            }
            if (typeof window.outerHeight === 'number' && window.outerHeight === 0) {
                safeDefineGetter(window, 'outerHeight', window.innerHeight + 72);
            }
        }, stealthProfile);
    }

    /**
     * 清理 Chrome 殘留的 Lock 檔案
     * @param {string} userDataDir - 使用者資料目錄
     * @returns {number} 成功清理的檔案數
     */
    static cleanLocks(userDataDir) {
        let cleaned = 0;
        if (!fs.existsSync(userDataDir)) return 0;
        
        LOCK_FILES.forEach(file => {
            const p = path.join(userDataDir, file);
            try {
                fs.lstatSync(p);
                fs.rmSync(p, { force: true, recursive: true });
                console.log(`🔓 [System] Removed Stale Lock: ${file}`);
                cleaned++;
            } catch (e) {
                if (e.code !== 'ENOENT') {
                    console.warn(`⚠️ [System] Failed to remove ${file}: ${e.message}`);
                }
            }
        });
        return cleaned;
    }

    /**
     * 列出設定檔根目錄的瀏覽器鎖定檔；不讀取內容，也不修改檔案。
     * @param {string} userDataDir
     * @returns {string[]}
     */
    static listExistingLocks(userDataDir) {
        if (!userDataDir || !fs.existsSync(userDataDir)) return [];
        return LOCK_FILES.filter((file) => {
            try {
                return fs.existsSync(path.join(userDataDir, file));
            } catch (_) {
                return false;
            }
        });
    }
}

module.exports = BrowserLauncher;
