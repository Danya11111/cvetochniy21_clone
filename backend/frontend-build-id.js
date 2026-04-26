'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const MAX_LEN = 64;

/** Canonical token in templates (sources in git). Never replace the occurrence that is the property name in `window.__F21_BUILD__`. */
const CANONICAL_BUILD_PLACEHOLDER = '__F21_BUILD__';

/** Observed server-side drift; must not appear in repo templates. */
const DRIFT_BAD_PLACEHOLDER = '__F21_BUILD_VALUE__';

const LOG_PREFIX = '[F21HtmlBuildInject]';

function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build id safe for URL path segments (Express route params, filenames).
 */
function sanitizeBuildId(s) {
    let t = String(s || '').trim();
    if (!t) return '';
    t = t.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, MAX_LEN);
    return t || '';
}

function readBuildIdFile(frontendPath) {
    try {
        const p = path.join(frontendPath, 'BUILD_ID');
        if (fs.existsSync(p)) {
            const s = fs.readFileSync(p, 'utf8').trim();
            if (s) return sanitizeBuildId(s);
        }
    } catch (_) {}
    return '';
}

function tryGitShortSha(repoRoot) {
    try {
        const out = execSync('git rev-parse --short=12 HEAD', {
            cwd: repoRoot,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 8000,
            env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
        }).trim();
        if (/^[0-9a-f]{4,40}$/i.test(out)) return out.toLowerCase().slice(0, 12);
    } catch (_) {}
    return '';
}

function timestampFallback() {
    return `ts_${Date.now()}`;
}

/**
 * Canonical frontend build id for versioned asset URLs and telemetry.
 * Priority: F21_FRONTEND_BUILD (env) → git HEAD (short) → frontend/BUILD_ID → process start timestamp.
 *
 * @param {{ repoRoot: string, frontendPath: string, logger?: { log: Function } }} opts
 * @returns {{ build: string, source: 'env' | 'git' | 'file' | 'timestamp_fallback' }}
 */
function resolveFrontendBuildId(opts) {
    const logger = opts.logger && typeof opts.logger.log === 'function' ? opts.logger : console;

    const envRaw = String(process.env.F21_FRONTEND_BUILD || '').trim();
    if (envRaw) {
        const build = sanitizeBuildId(envRaw);
        if (build) {
            logger.log('[F21FrontendBuild] resolved', JSON.stringify({ build, source: 'env' }));
            return { build, source: 'env' };
        }
    }

    const git = tryGitShortSha(opts.repoRoot);
    if (git) {
        logger.log('[F21FrontendBuild] resolved', JSON.stringify({ build: git, source: 'git' }));
        return { build: git, source: 'git' };
    }

    const fileId = readBuildIdFile(opts.frontendPath);
    if (fileId) {
        logger.log('[F21FrontendBuild] resolved', JSON.stringify({ build: fileId, source: 'file' }));
        return { build: fileId, source: 'file' };
    }

    const build = timestampFallback();
    logger.log('[F21FrontendBuild] resolved', JSON.stringify({ build, source: 'timestamp_fallback' }));
    return { build, source: 'timestamp_fallback' };
}

/**
 * True if HTML still contains the old bug pattern: `window.<buildId> =` (property name was corrupted by naive global replace).
 * @param {string} html
 * @param {string} buildId — sanitized effective build id
 */
function hasBuggyWindowDotBuildAssignment(html, buildId) {
    const b = String(buildId || '').trim();
    if (!b) return false;
    return new RegExp(`window\\.${escapeRegExp(b)}\\s*=`).test(String(html || ''));
}

/**
 * After injection, no standalone `__F21_BUILD__` tokens may remain except inside `window.__F21_BUILD__`.
 */
function hasResidualCanonicalPlaceholder(html) {
    const s = String(html || '').replace(/window\.__F21_BUILD__/g, '');
    return s.includes(CANONICAL_BUILD_PLACEHOLDER);
}

/**
 * Storefront/admin head script must keep the real property name `__F21_BUILD__` and only substitute the RHS string.
 *
 * @param {string} html
 */
function hasWellFormedWindowBuildScript(html) {
    return /window\.__F21_BUILD__\s*=\s*(?:'[^']*'|"[^"]*")/.test(String(html || ''));
}

/**
 * Inject build id into HTML templates. Replaces `__F21_BUILD__` everywhere **except** the property name in
 * `window.__F21_BUILD__` (naive global replace would yield `window.<buildId> = '…'`, which is invalid).
 *
 * @param {string} html
 * @param {string} buildId
 * @param {{ logger?: { log: Function, error: Function }, surface?: string } | undefined} options
 * @returns {string}
 */
function injectHtmlBuildStamp(html, buildId, options) {
    const opts = options || {};
    const logger =
        opts.logger && typeof opts.logger.log === 'function'
            ? opts.logger
            : typeof console !== 'undefined'
              ? console
              : { log() {}, error() {} };
    const surface = String(opts.surface || 'html');

    const raw = String(html || '');
    const effectiveBuild = sanitizeBuildId(buildId) || 'missing';

    if (raw.includes(DRIFT_BAD_PLACEHOLDER)) {
        const payload = JSON.stringify({ surface, token: DRIFT_BAD_PLACEHOLDER, tag: 'DRIFT_BAD_PLACEHOLDER' });
        logger.error(`${LOG_PREFIX} ERROR DRIFT_BAD_PLACEHOLDER env=${payload}`);
        throw new Error(`${LOG_PREFIX} ERROR DRIFT_BAD_PLACEHOLDER`);
    }

    let replaceCount = 0;
    let skipWindowPropCount = 0;
    const out = raw.replace(/__F21_BUILD__/g, (match, offset) => {
        if (offset >= 7 && raw.slice(offset - 7, offset) === 'window.') {
            skipWindowPropCount++;
            return match;
        }
        replaceCount++;
        return effectiveBuild;
    });

    if (hasResidualCanonicalPlaceholder(out)) {
        const payload = JSON.stringify({
            surface,
            tag: 'RESIDUAL_CANONICAL_PLACEHOLDER',
            replaceCount,
            skipWindowPropCount,
            build: effectiveBuild
        });
        logger.error(`${LOG_PREFIX} ERROR RESIDUAL_CANONICAL_PLACEHOLDER env=${payload}`);
        throw new Error(`${LOG_PREFIX} ERROR RESIDUAL_CANONICAL_PLACEHOLDER`);
    }

    if (hasBuggyWindowDotBuildAssignment(out, effectiveBuild)) {
        const payload = JSON.stringify({ surface, tag: 'BUG_WINDOW_DOT_BUILD_AS_PROPERTY', build: effectiveBuild });
        logger.error(`${LOG_PREFIX} ERROR BUG_WINDOW_DOT_BUILD_AS_PROPERTY env=${payload}`);
        throw new Error(`${LOG_PREFIX} ERROR BUG_WINDOW_DOT_BUILD_AS_PROPERTY`);
    }

    if (!hasWellFormedWindowBuildScript(out)) {
        const payload = JSON.stringify({ surface, tag: 'BROKEN_WINDOW_BUILD_SCRIPT' });
        logger.error(`${LOG_PREFIX} ERROR BROKEN_WINDOW_BUILD_SCRIPT env=${payload}`);
        throw new Error(`${LOG_PREFIX} ERROR BROKEN_WINDOW_BUILD_SCRIPT`);
    }

    logger.log(
        `${LOG_PREFIX} OK build_inject env=${JSON.stringify({
            surface,
            build: effectiveBuild,
            replaceCount,
            skipWindowPropCount
        })}`
    );

    return out;
}

module.exports = {
    CANONICAL_BUILD_PLACEHOLDER,
    DRIFT_BAD_PLACEHOLDER,
    sanitizeBuildId,
    resolveFrontendBuildId,
    injectHtmlBuildStamp,
    /** @internal testing / diagnostics */
    hasBuggyWindowDotBuildAssignment,
    hasResidualCanonicalPlaceholder,
    hasWellFormedWindowBuildScript
};
