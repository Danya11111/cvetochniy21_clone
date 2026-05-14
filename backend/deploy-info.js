'use strict';

const fs = require('fs');
const path = require('path');

function readDeployInfoFile(repoRoot) {
    const fp = path.join(repoRoot, 'deploy', 'deploy-info.json');
    try {
        const raw = fs.readFileSync(fp, 'utf8');
        const json = JSON.parse(raw);
        return { ok: true, path: fp, json };
    } catch {
        return { ok: false, path: fp, json: null };
    }
}

function safeIsoMtime(filePath) {
    try {
        return new Date(fs.statSync(filePath).mtimeMs).toISOString();
    } catch {
        return null;
    }
}

function basenameOnly(p) {
    if (!p) return null;
    const s = String(p).trim();
    if (!s) return null;
    return path.basename(s);
}

function publicOriginOnly(config) {
    const raw = String((config && (config.APP_PUBLIC_URL || config.BASE_URL)) || '')
        .trim()
        .replace(/\/+$/, '');
    return raw || null;
}

/**
 * Безопасный снимок для GET /api/deploy-info (без секретов, без полного пути SQLite).
 * @param {{
 *   repoRoot: string,
 *   config: object,
 *   processEnv: NodeJS.ProcessEnv,
 *   storefrontBuildId?: string,
 *   storefrontBuildSource?: string
 * }} p
 */
function buildDeployInfoResponse({ repoRoot, config, processEnv, storefrontBuildId, storefrontBuildSource }) {
    const disk = readDeployInfoFile(repoRoot);
    const j = disk.ok && disk.json && typeof disk.json === 'object' ? disk.json : {};

    const commit =
        (typeof j.commit === 'string' && j.commit.trim()) ||
        String(processEnv.GITHUB_SHA || '').trim() ||
        String(processEnv.COMMIT_SHA || '').trim() ||
        'unknown';

    const shortCommit =
        (typeof j.shortCommit === 'string' && j.shortCommit.trim()) ||
        (commit.length >= 7 ? commit.slice(0, 7) : commit);

    const deployedAt = j.deployedAt != null ? j.deployedAt : null;
    const runId = j.runId != null ? j.runId : null;
    const workflow = j.workflow != null ? j.workflow : null;

    let source = 'unknown';
    if (disk.ok && disk.json) {
        source = 'deploy/deploy-info.json';
    } else if (String(processEnv.GITHUB_SHA || '').trim() || String(processEnv.COMMIT_SHA || '').trim()) {
        source = 'environment';
    }

    const sqliteRaw = processEnv.F21_SQLITE_PATH && String(processEnv.F21_SQLITE_PATH).trim();

    const frontendIndex = path.join(repoRoot, 'frontend', 'index.html');
    const frontendApp = path.join(repoRoot, 'frontend', 'app.js');

    return {
        ok: true,
        commit,
        shortCommit,
        deployedAt,
        runId,
        workflow,
        source,
        nodeEnv: processEnv.NODE_ENV || null,
        cwd: process.cwd(),
        appPublicUrl: publicOriginOnly(config),
        sqlitePathConfigured: Boolean(sqliteRaw),
        sqlitePathBasename: sqliteRaw ? basenameOnly(sqliteRaw) : null,
        frontendIndexMtime: safeIsoMtime(frontendIndex),
        frontendAppMtime: safeIsoMtime(frontendApp),
        storefrontBuildId: storefrontBuildId || null,
        storefrontBuildSource: storefrontBuildSource || null
    };
}

module.exports = {
    buildDeployInfoResponse,
    readDeployInfoFile,
    safeIsoMtime,
    basenameOnly,
    publicOriginOnly
};
