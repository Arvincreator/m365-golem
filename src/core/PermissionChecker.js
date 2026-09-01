// ============================================================
// 🛡️ PermissionChecker — Autonomous Mode Safety Gate
// Inspired by OpenHarness multi-level permission modes
// ============================================================
const fs = require('fs');
const path = require('path');
const ConfigManager = require('../config');

/**
 * 自主模式下禁止自動執行的高風險技能清單（預設值）
 * 使用者手動下指令不受此限制影響。
 */
const DEFAULT_BLOCKED_AUTONOMY = [
    'self-evolution',   // 修改自身程式碼，風險極高
    'self_evolution',
    'reincarnate',      // 覆蓋 persona 設定
    'patch',            // 直接修改系統原始碼
    'system-update',    // 覆蓋本地代碼
    'SystemUpdate',
];

/**
 * 自主模式下的類型黑名單（taskName 的 type 欄位）
 */
const DEFAULT_BLOCKED_TYPES = [
    'SystemUpdate',
    'FORCE_UPDATE',
];

class PermissionChecker {
    /**
     * 讀取使用者自訂的 permissions.json（若存在）
     * 不存在時靜默使用預設值
     * @returns {{ blockedSkills: string[], blockedTypes: string[] }}
     */
    static _loadConfig() {
        const userDataDir = ConfigManager.CONFIG.USER_DATA_DIR || './golem_memory';
        const permFile = path.resolve(userDataDir, 'permissions.json');

        if (fs.existsSync(permFile)) {
            try {
                const raw = JSON.parse(fs.readFileSync(permFile, 'utf8'));
                return {
                    blockedSkills: [
                        ...DEFAULT_BLOCKED_AUTONOMY,
                        ...(raw.blockedSkills || [])
                    ],
                    blockedTypes: [
                        ...DEFAULT_BLOCKED_TYPES,
                        ...(raw.blockedTypes || [])
                    ],
                    allowAll: raw.allowAll === true,  // 緊急通道：完全解除自主限制
                };
            } catch (e) {
                console.warn(`⚠️ [Permission] permissions.json 解析失敗，使用預設規則: ${e.message}`);
            }
        }

        return {
            blockedSkills: DEFAULT_BLOCKED_AUTONOMY,
            blockedTypes: DEFAULT_BLOCKED_TYPES,
            allowAll: false,
        };
    }

    /**
     * 判斷自主模式下是否允許執行指定類型的任務
     * （僅限 AutonomyManager.run() 呼叫，使用者手動指令不受影響）
     *
     * @param {string} type - 任務類型（如 'NewsChat', 'self-evolution'）
     * @returns {{ allowed: boolean, reason: string }}
     */
    static isAllowedAutonomy(type) {
        const config = this._loadConfig();

        if (config.allowAll) {
            return { allowed: true, reason: 'allowAll override' };
        }

        const typeStr = String(type || '').toLowerCase();

        // 檢查 type 黑名單
        const blockedType = config.blockedTypes.find(
            t => typeStr === t.toLowerCase()
        );
        if (blockedType) {
            return {
                allowed: false,
                reason: `自主模式禁止執行類型「${type}」（高風險操作）。如需手動執行，請直接下指令。`
            };
        }

        // 檢查 skill 名稱黑名單
        const blockedSkill = config.blockedSkills.find(
            s => typeStr.includes(s.toLowerCase())
        );
        if (blockedSkill) {
            return {
                allowed: false,
                reason: `自主模式禁止執行技能「${blockedSkill}」（高風險操作）。如需手動執行，請直接下指令。`
            };
        }

        return { allowed: true, reason: 'ok' };
    }

    /**
     * 判斷指定技能是否在自主模式黑名單中（技能名稱直接對照）
     *
     * @param {string} skillName
     * @returns {{ allowed: boolean, reason: string }}
     */
    static isSkillAllowedInAutonomy(skillName) {
        return this.isAllowedAutonomy(skillName);
    }
}

module.exports = PermissionChecker;
