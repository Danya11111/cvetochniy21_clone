'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    buildDeployInfoResponse,
    readDeployInfoFile,
    basenameOnly,
    publicOriginOnly
} = require('../deploy-info');

function test(name, fn) {
    try {
        fn();
        process.stdout.write(`PASS ${name}\n`);
    } catch (e) {
        process.stderr.write(`FAIL ${name}: ${e.message}\n`);
        process.exitCode = 1;
    }
}

test('basenameOnly hides directory segments', () => {
    assert.strictEqual(basenameOnly('/var/lib/foo.sqlite'), 'foo.sqlite');
    assert.strictEqual(basenameOnly(''), null);
});

test('publicOriginOnly strips trailing slash', () => {
    assert.strictEqual(publicOriginOnly({ APP_PUBLIC_URL: 'https://example.com/' }), 'https://example.com');
    assert.strictEqual(publicOriginOnly({ BASE_URL: 'http://host' }), 'http://host');
    assert.strictEqual(publicOriginOnly({}), null);
});

test('buildDeployInfoResponse prefers deploy/deploy-info.json', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f21-deploy-info-'));
    try {
        fs.mkdirSync(path.join(tmp, 'deploy'), { recursive: true });
        fs.writeFileSync(
            path.join(tmp, 'deploy', 'deploy-info.json'),
            JSON.stringify({
                commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
                shortCommit: 'deadbee',
                deployedAt: '2026-05-14T12:00:00.000Z',
                runId: '12345',
                workflow: 'Deploy via SSH'
            })
        );
        fs.mkdirSync(path.join(tmp, 'frontend'), { recursive: true });
        fs.writeFileSync(path.join(tmp, 'frontend', 'index.html'), '<html></html>');
        fs.writeFileSync(path.join(tmp, 'frontend', 'app.js'), '// app');

        const prevSha = process.env.GITHUB_SHA;
        process.env.GITHUB_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        try {
            const body = buildDeployInfoResponse({
                repoRoot: tmp,
                config: { APP_PUBLIC_URL: 'https://app.example/' },
                processEnv: { ...process.env, NODE_ENV: 'test', F21_SQLITE_PATH: '/private/secret/path/db.sqlite' },
                storefrontBuildId: 'build_x',
                storefrontBuildSource: 'unit'
            });
            assert.strictEqual(body.commit, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
            assert.strictEqual(body.shortCommit, 'deadbee');
            assert.strictEqual(body.source, 'deploy/deploy-info.json');
            assert.strictEqual(body.sqlitePathBasename, 'db.sqlite');
            assert.strictEqual(body.sqlitePathConfigured, true);
            assert.strictEqual(body.storefrontBuildId, 'build_x');
            assert.strictEqual(body.nodeEnv, 'test');
            assert.ok(body.frontendIndexMtime);
            assert.ok(body.frontendAppMtime);
        } finally {
            if (prevSha === undefined) delete process.env.GITHUB_SHA;
            else process.env.GITHUB_SHA = prevSha;
        }
    } finally {
        try {
            fs.rmSync(tmp, { recursive: true, force: true });
        } catch (_) {}
    }
});

test('readDeployInfoFile returns ok:false when missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f21-deploy-info-miss-'));
    try {
        const r = readDeployInfoFile(tmp);
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.json, null);
    } finally {
        try {
            fs.rmSync(tmp, { recursive: true, force: true });
        } catch (_) {}
    }
});
