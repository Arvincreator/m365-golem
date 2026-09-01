/**
 * Golem i18n — Lightweight internationalization system
 *
 * Supports: zh-TW (default), en, ja
 * Usage:
 *   const { t, setLocale, getLocale } = require('./src/i18n');
 *   t('system.boot.starting');  // → "🚀 Golem 正在啟動..."
 *   setLocale('en');
 *   t('system.boot.starting');  // → "🚀 Golem is starting..."
 */

const fs = require('fs');
const path = require('path');

// Supported locales
const SUPPORTED_LOCALES = ['zh-TW', 'en', 'ja'];
const DEFAULT_LOCALE = 'zh-TW';

// Cache loaded translations
const _cache = {};
let _currentLocale = process.env.GOLEM_LOCALE || DEFAULT_LOCALE;

/**
 * Load a locale file from disk
 */
function loadLocale(locale) {
    if (_cache[locale]) return _cache[locale];

    const filePath = path.join(__dirname, 'locales', `${locale}.json`);
    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        _cache[locale] = data;
        return data;
    } catch (e) {
        console.warn(`[i18n] Failed to load locale "${locale}": ${e.message}`);
        if (locale !== DEFAULT_LOCALE) {
            return loadLocale(DEFAULT_LOCALE);
        }
        return {};
    }
}

/**
 * Get nested value from object by dot-path
 * e.g., resolve(obj, 'system.boot.starting')
 */
function resolve(obj, keyPath) {
    return keyPath.split('.').reduce((acc, key) => {
        return acc && typeof acc === 'object' ? acc[key] : undefined;
    }, obj);
}

/**
 * Translate a key with optional variable substitution
 * @param {string} key - Dot-separated key path (e.g., 'system.boot.starting')
 * @param {object} vars - Variables for substitution (e.g., { name: 'Golem' })
 * @returns {string} Translated string or key as fallback
 *
 * @example
 *   t('system.boot.starting')
 *   t('system.boot.model_loaded', { model: 'Gemini 2.5' })
 */
function t(key, vars = {}) {
    const messages = loadLocale(_currentLocale);
    let text = resolve(messages, key);

    // Fallback to default locale
    if (text === undefined && _currentLocale !== DEFAULT_LOCALE) {
        const fallback = loadLocale(DEFAULT_LOCALE);
        text = resolve(fallback, key);
    }

    // Fallback to key itself
    if (text === undefined) {
        return key;
    }

    // Variable substitution: {{varName}}
    if (typeof text === 'string' && Object.keys(vars).length > 0) {
        text = text.replace(/\{\{(\w+)\}\}/g, (_, name) => {
            return vars[name] !== undefined ? String(vars[name]) : `{{${name}}}`;
        });
    }

    return text;
}

/**
 * Set the current locale
 * @param {string} locale - Locale code (zh-TW, en, ja)
 */
function setLocale(locale) {
    if (!SUPPORTED_LOCALES.includes(locale)) {
        console.warn(`[i18n] Unsupported locale "${locale}". Supported: ${SUPPORTED_LOCALES.join(', ')}`);
        return false;
    }
    _currentLocale = locale;
    loadLocale(locale); // Pre-warm cache
    return true;
}

/**
 * Get the current locale
 */
function getLocale() {
    return _currentLocale;
}

/**
 * Get list of supported locales
 */
function getSupportedLocales() {
    return [...SUPPORTED_LOCALES];
}

module.exports = { t, setLocale, getLocale, getSupportedLocales };
