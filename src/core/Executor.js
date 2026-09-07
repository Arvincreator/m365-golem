const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

function looksLikeUtf16Le(buffer) {
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return true;

    const pairCount = Math.floor(Math.min(buffer.length, 128) / 2);
    if (pairCount < 2) return false;

    let oddNulls = 0;
    let evenNulls = 0;
    for (let index = 0; index < pairCount * 2; index += 2) {
        if (buffer[index] === 0) evenNulls += 1;
        if (buffer[index + 1] === 0) oddNulls += 1;
    }

    return oddNulls >= 2 && oddNulls / pairCount >= 0.3 && oddNulls > evenNulls;
}

function createOutputDecoder() {
    let decoder = null;
    let pending = Buffer.alloc(0);

    const initialize = () => {
        decoder = new StringDecoder(looksLikeUtf16Le(pending) ? 'utf16le' : 'utf8');
        const text = decoder.write(pending);
        pending = Buffer.alloc(0);
        return text.replace(/^\ufeff/, '');
    };

    return {
        write(data) {
            const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
            if (decoder) return decoder.write(chunk);

            pending = Buffer.concat([pending, chunk]);
            if (pending.length < 6) return '';
            return initialize();
        },
        end() {
            const prefix = decoder ? '' : initialize();
            return prefix + decoder.end();
        },
    };
}

class Executor {
    constructor() {
        this.defaultTimeout = 180000; // 預設超時：180秒 (延長超時以通融 find 等長時指令)
    }

    /**
     * 執行 Shell 指令 (進階版)
     * @param {string} command - 要執行的指令
     * @param {Object} options - 選項設定
     * @param {string} [options.cwd] - 指定執行目錄 (預設為 process.cwd())
     * @param {number} [options.timeout] - 設定超時毫秒數 (預設 60000ms, 0 為不限制)
     * @param {function(string):void} [options.onData] - 即時輸出回調函式 (用於 Socket.io 串流)
     * @returns {Promise<string>} - 回傳完整的輸出結果
     */
    run(command, options = {}) {
        return new Promise((resolve, reject) => {
            const cwd = options.cwd || process.cwd();
            const timeout = options.timeout !== undefined ? options.timeout : this.defaultTimeout;
            const isWindows = process.platform === 'win32';
            const commandToRun = isWindows ? (process.env.ComSpec || 'cmd.exe') : command;
            const commandArgs = isWindows
                ? ['/d', '/u', '/s', '/c', `chcp 65001>nul & ${command}`]
                : [];

            console.log(`⚡ [Executor] Running: "${command}" in ${cwd}`);

            // 使用 spawn 啟動子進程
            const child = spawn(commandToRun, commandArgs, {
                shell: !isWindows, // Windows 由 cmd /c 處理 pipe 與重導向，並以 Unicode 回傳內建指令結果
                cwd: cwd,        // 設定工作目錄
                env: process.platform === 'win32'
                    ? { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
                    : process.env,
                windowsHide: true // Windows 上不顯示命令列視窗
            });

            let stdout = '';
            let stderr = '';
            let isDone = false; // 避免 timeout 後又觸發 close
            const stdoutDecoder = createOutputDecoder();
            const stderrDecoder = createOutputDecoder();

            // --- 設定超時計時器 ---
            let timer = null;
            if (timeout > 0) {
                timer = setTimeout(() => {
                    if (!isDone) {
                        isDone = true;
                        child.kill('SIGKILL'); // 殺死進程
                        const msg = `❌ [Executor] Command timed out after ${timeout}ms: "${command}"`;
                        console.warn(msg);
                        reject(new Error(msg));
                    }
                }, timeout);
            }

            // --- 處理標準輸出 ---
            child.stdout.on('data', (data) => {
                const text = stdoutDecoder.write(data);
                stdout += text;

                // 如果有設定即時回調 (例如送給前端 Socket)，就在這裡呼叫
                if (text && options.onData && typeof options.onData === 'function') {
                    options.onData(text);
                }
            });

            // --- 處理錯誤輸出 ---
            child.stderr.on('data', (data) => {
                const text = stderrDecoder.write(data);
                stderr += text;

                // 錯誤訊息通常也要即時顯示
                if (text && options.onData && typeof options.onData === 'function') {
                    options.onData(text);
                }
            });

            // --- 處理進程錯誤 (如 spawn 失敗) ---
            child.on('error', (err) => {
                if (!isDone) {
                    isDone = true;
                    if (timer) clearTimeout(timer);
                    reject(err);
                }
            });

            // --- 處理進程結束 ---
            child.on('close', (code) => {
                if (!isDone) {
                    isDone = true;
                    if (timer) clearTimeout(timer); // 清除計時器

                    const stdoutTail = stdoutDecoder.end();
                    const stderrTail = stderrDecoder.end();
                    stdout += stdoutTail;
                    stderr += stderrTail;
                    if (options.onData && typeof options.onData === 'function') {
                        if (stdoutTail) options.onData(stdoutTail);
                        if (stderrTail) options.onData(stderrTail);
                    }

                    if (code !== 0) {
                        // 回傳詳細錯誤，讓 AI 知道發生什麼事
                        // 這裡選擇 resolve 而不是 reject，是因為有時候 exit code 1 只是警告
                        // 您可以根據需求改回 reject
                        console.warn(`⚠️ [Executor] Finished with code ${code}`);
                        reject(new Error(`Command failed (Exit Code ${code}).\nStderr: ${stderr}\nStdout: ${stdout}`));
                    } else {
                        // console.log(`✅ [Executor] Finished successfully.`);
                        resolve(stdout);
                    }
                }
            });
        });
    }
}

module.exports = Executor;
