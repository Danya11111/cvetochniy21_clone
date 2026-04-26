#!/usr/bin/env node
/**
 * Repo-side guardrail: deploy-артефакты, согласованность systemd ↔ env.example,
 * покрытие env.example ключами из кода (backend), nginx routing contract,
 * обязательные маркеры в PRODUCTION-SOURCE-OF-TRUTH, битые ссылки в markdown.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');

const REQUIRED_FILES = [
    'deploy/env.example',
    'deploy/README.md',
    'deploy/PRODUCTION-RUNBOOK-ru.md',
    'deploy/PRODUCTION-SOURCE-OF-TRUTH-ru.md',
    'deploy/BUILD-DELIVERY-RUNBOOK-ru.md',
    'deploy/nginx/tgtsvetochnii21.ru.example.conf',
    'deploy/systemd/cvet21.service.example',
    'deploy/systemd/admin-access.conf.example',
    'deploy/systemd/telegram-proxy.conf.example',
    'deploy/systemd/broadcast-tuning.conf.example',
    'docs/broadcast-ops-ru.md'
];

/** Ключи, допустимые в env.example без прямого чтения в сканируемых файлах (операционные / runtime). */
const ALLOWLIST_ENV_EXAMPLE_WITHOUT_CODE = new Set(['NODE_ENV']);

/** Обязательные подстроки в deploy/PRODUCTION-SOURCE-OF-TRUTH-ru.md (grep-friendly канон). */
const PRODUCTION_SOURCE_REQUIRED_SUBSTRINGS = [
    'cvet21.service',
    '/etc/cvetochny21.env',
    'injectHtmlBuildStamp',
    '/api/health/ops',
    'ADMIN_TELEGRAM_IDS',
    'TELEGRAM_ADMIN_IDS',
    'TELEGRAM_PROXY_URL',
    'F21_ADMIN_OPEN_SECRET',
    'deploy/env.example',
    'deploy/nginx/tgtsvetochnii21.ru.example.conf'
];

/** Маркеры канонического nginx example (все пути через proxy к Node). */
const NGINX_EXAMPLE_REQUIRED_TOKENS = [
    'proxy_pass',
    'f21_node_upstream',
    'upstream',
    'admin-embed',
    'admin-assets',
    '/api/',
    'app.',
    'styles.'
];

/** Markdown-ссылки вида `path/to/file.md` в deploy/docs — проверка существования. */
function makeDocRefRegex() {
    return /`((?:deploy|docs)\/[a-zA-Z0-9._/-]+\.(?:md|conf|example))`/g;
}

function read(p) {
    return fs.readFileSync(path.join(repoRoot, p), 'utf8');
}

function extractEnvExampleKeys(content) {
    const keys = new Set();
    for (const line of content.split(/\r?\n/)) {
        const t = line.trim();
        const active = /^([A-Z][A-Z0-9_]*)=/.exec(t);
        if (active && !t.startsWith('#')) {
            keys.add(active[1]);
            continue;
        }
        const commented = /^#\s*([A-Z][A-Z0-9_]*)=/.exec(t);
        if (commented) keys.add(commented[1]);
    }
    return keys;
}

function extractSystemdEnvironmentKeys(content) {
    const keys = new Set();
    const re = /Environment=(?:"([A-Z][A-Z0-9_]*)=|([A-Z][A-Z0-9_]*)=)/g;
    let m;
    while ((m = re.exec(content)) !== null) {
        keys.add(m[1] || m[2]);
    }
    return keys;
}

function extractEnvKeysFromSource(content) {
    const keys = new Set();
    const patterns = [
        /\benv(?:Bool|Int|List)?\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g,
        /process\.env\.([A-Z][A-Z0-9_]*)/g,
        /process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g
    ];
    for (const re of patterns) {
        let m;
        while ((m = re.exec(content)) !== null) {
            keys.add(m[1]);
        }
    }
    return keys;
}

function scanCodeEnvKeys() {
    const files = [
        'backend/config.js',
        'backend/db.js',
        'backend/server.js',
        'backend/frontend-build-id.js',
        'backend/telegram-client.js'
    ];
    const all = new Set();
    for (const f of files) {
        const full = path.join(repoRoot, f);
        if (!fs.existsSync(full)) {
            console.error(`[verify-manifest] MISSING_SOURCE ${f}`);
            process.exit(1);
        }
        extractEnvKeysFromSource(read(f)).forEach((k) => all.add(k));
    }
    return all;
}

function verifyMarkdownRefs(extraDocs = []) {
    const toCheck = [
        'deploy/README.md',
        'deploy/PRODUCTION-RUNBOOK-ru.md',
        'deploy/PRODUCTION-SOURCE-OF-TRUTH-ru.md',
        'deploy/BUILD-DELIVERY-RUNBOOK-ru.md',
        'docs/broadcast-ops-ru.md',
        ...extraDocs
    ];
    const missing = [];
    for (const doc of toCheck) {
        if (!fs.existsSync(path.join(repoRoot, doc))) continue;
        const text = read(doc);
        let m;
        const local = makeDocRefRegex();
        while ((m = local.exec(text)) !== null) {
            const rel = m[1];
            if (!fs.existsSync(path.join(repoRoot, rel))) {
                missing.push({ doc, ref: rel });
            }
        }
    }
    return missing;
}

/** В production nginx example не должно быть незакомментированных root/alias (HTML только через Node). */
function findUncommentedRootOrAlias(content) {
    const bad = [];
    for (const line of content.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        if (/^(root|alias)\s+/i.test(t)) {
            bad.push(t);
        }
    }
    return bad;
}

function verifyNginxExampleTokens(content) {
    const lower = content.toLowerCase();
    const missing = [];
    for (const tok of NGINX_EXAMPLE_REQUIRED_TOKENS) {
        const needle = tok.toLowerCase();
        if (!lower.includes(needle)) {
            missing.push(tok);
        }
    }
    return missing;
}

function verifyProductionSourceSubstrings(content) {
    const missing = [];
    for (const s of PRODUCTION_SOURCE_REQUIRED_SUBSTRINGS) {
        if (!content.includes(s)) {
            missing.push(s);
        }
    }
    return missing;
}

function verifyDeployReadmeLinksSourceOfTruth(content) {
    if (!content.includes('PRODUCTION-SOURCE-OF-TRUTH')) {
        return ['deploy/README.md must mention deploy/PRODUCTION-SOURCE-OF-TRUTH-ru.md'];
    }
    return [];
}

let failed = false;

for (const f of REQUIRED_FILES) {
    if (!fs.existsSync(path.join(repoRoot, f))) {
        console.error(`[verify-manifest] MISSING_FILE ${f}`);
        failed = true;
    }
}

if (failed) process.exit(1);

const codeKeys = scanCodeEnvKeys();

const envExample = read('deploy/env.example');
const envKeys = extractEnvExampleKeys(envExample);

const systemdParts = [
    'deploy/systemd/cvet21.service.example',
    'deploy/systemd/admin-access.conf.example',
    'deploy/systemd/telegram-proxy.conf.example',
    'deploy/systemd/broadcast-tuning.conf.example'
];

const systemdKeys = new Set();
for (const p of systemdParts) {
    extractSystemdEnvironmentKeys(read(p)).forEach((k) => systemdKeys.add(k));
}

const missingInEnv = [...systemdKeys].filter((k) => !envKeys.has(k)).sort();
if (missingInEnv.length) {
    console.error('[verify-manifest] SYSTEMD_KEYS_NOT_IN_ENV_EXAMPLE', missingInEnv.join(', '));
    failed = true;
}

const codeNotInEnv = [...codeKeys].filter((k) => !envKeys.has(k) && !ALLOWLIST_ENV_EXAMPLE_WITHOUT_CODE.has(k)).sort();
if (codeNotInEnv.length) {
    console.error('[verify-manifest] CODE_ENV_KEYS_MISSING_IN_ENV_EXAMPLE', codeNotInEnv.join(', '));
    failed = true;
}

const envNotInCode = [...envKeys].filter((k) => !codeKeys.has(k) && !ALLOWLIST_ENV_EXAMPLE_WITHOUT_CODE.has(k)).sort();
if (envNotInCode.length) {
    console.warn('[verify-manifest] WARN_ENV_EXAMPLE_KEYS_NOT_IN_SCANNED_CODE', envNotInCode.join(', '));
}

const badRefs = verifyMarkdownRefs();
if (badRefs.length) {
    for (const x of badRefs) {
        console.error(`[verify-manifest] BROKEN_DOC_REF doc=${x.doc} ref=${x.ref}`);
    }
    failed = true;
}

const nginxText = read('deploy/nginx/tgtsvetochnii21.ru.example.conf');
const nginxMissing = verifyNginxExampleTokens(nginxText);
if (nginxMissing.length) {
    console.error('[verify-manifest] NGINX_EXAMPLE_MISSING_TOKENS', nginxMissing.join(', '));
    failed = true;
}

const nginxRootAlias = findUncommentedRootOrAlias(nginxText);
if (nginxRootAlias.length) {
    console.error('[verify-manifest] NGINX_EXAMPLE_FORBIDDEN_ROOT_OR_ALIAS', nginxRootAlias.join(' | '));
    failed = true;
}

const sourceText = read('deploy/PRODUCTION-SOURCE-OF-TRUTH-ru.md');
const sourceMissing = verifyProductionSourceSubstrings(sourceText);
if (sourceMissing.length) {
    console.error('[verify-manifest] PRODUCTION_SOURCE_MISSING_SUBSTRINGS', sourceMissing.join(', '));
    failed = true;
}

const readmeIssues = verifyDeployReadmeLinksSourceOfTruth(read('deploy/README.md'));
if (readmeIssues.length) {
    for (const msg of readmeIssues) {
        console.error(`[verify-manifest] README_ISSUE ${msg}`);
    }
    failed = true;
}

if (!failed) {
    console.log(
        `[verify-manifest] OK files=${REQUIRED_FILES.length} code_env_keys=${codeKeys.size} env_example_keys=${envKeys.size} systemd_env_keys=${systemdKeys.size}`
    );
}

process.exit(failed ? 1 : 0);
