const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const frontendPath = path.join(repoRoot, 'frontend');

const {
    sanitizeBuildId,
    injectHtmlBuildStamp,
    resolveFrontendBuildId,
    hasBuggyWindowDotBuildAssignment,
    hasResidualCanonicalPlaceholder,
    DRIFT_BAD_PLACEHOLDER
} = require('../frontend-build-id');

const quietLogger = { log() {}, error() {} };

function test(name, fn) {
    try {
        fn();
        process.stdout.write(`PASS ${name}\n`);
    } catch (e) {
        process.stderr.write(`FAIL ${name}: ${e.message}\n`);
        process.exitCode = 1;
    }
}

test('sanitizeBuildId strips unsafe chars', () => {
    assert.strictEqual(sanitizeBuildId('  abc/def  '), 'abc_def');
    assert.strictEqual(sanitizeBuildId('2026.04.13.5'), '2026.04.13.5');
});

test('injectHtmlBuildStamp replaces placeholders but keeps window.__F21_BUILD__ property name', () => {
    const html =
        '<script>window.__F21_BUILD__ = \'__F21_BUILD__\'</script><link href="/x.__F21_BUILD__.css">';
    const out = injectHtmlBuildStamp(html, 'gitsha12abcd', { logger: quietLogger, surface: 'unit' });
    assert.ok(out.includes('window.__F21_BUILD__'), 'property name must stay');
    assert.ok(out.includes("window.__F21_BUILD__ = 'gitsha12abcd'"), 'RHS must be build id');
    assert.ok(out.includes('href="/x.gitsha12abcd.css"'));
    const residual = out.replace(/window\.__F21_BUILD__/g, '');
    assert.ok(!residual.includes('__F21_BUILD__'), 'no leftover canonical token outside window.__F21_BUILD__');
});

test('injectHtmlBuildStamp does not produce window.<build> = (old naive replace bug)', () => {
    const html = '<script>window.__F21_BUILD__ = \'__F21_BUILD__\'</script>';
    const out = injectHtmlBuildStamp(html, 'abc12def34', { logger: quietLogger, surface: 'unit' });
    assert.ok(!/window\.abc12def34\s*=/.test(out), 'must not corrupt property access');
    assert.ok(out.includes('window.__F21_BUILD__'));
});

test('hasBuggyWindowDotBuildAssignment detects corrupted script', () => {
    const buggy = "<script>window.abc12def34 = 'abc12def34';</script>";
    assert.strictEqual(hasBuggyWindowDotBuildAssignment(buggy, 'abc12def34'), true);
    assert.strictEqual(
        hasBuggyWindowDotBuildAssignment(
            "<script>window.__F21_BUILD__ = 'abc12def34';</script>",
            'abc12def34'
        ),
        false
    );
});

test('hasResidualCanonicalPlaceholder detects stray __F21_BUILD__ after stripping window.__F21_BUILD__', () => {
    const broken =
        "<script>window.__F21_BUILD__ = 'ok'</script>tail __F21_BUILD__";
    assert.strictEqual(hasResidualCanonicalPlaceholder(broken), true);
    const ok = "<script>window.__F21_BUILD__ = 'ok'</script>tail only";
    assert.strictEqual(hasResidualCanonicalPlaceholder(ok), false);
});

test('injectHtmlBuildStamp throws BROKEN_WINDOW_BUILD_SCRIPT without window.__F21_BUILD__ assignment', () => {
    assert.throws(
        () => injectHtmlBuildStamp('<html><div>x</div></html>', 'x', { logger: quietLogger, surface: 'unit' }),
        /BROKEN_WINDOW_BUILD_SCRIPT/
    );
});

test('injectHtmlBuildStamp throws on DRIFT __F21_BUILD_VALUE__', () => {
    const bad = `<script>window.__F21_BUILD__ = '__F21_BUILD__'</script>${DRIFT_BAD_PLACEHOLDER}`;
    assert.throws(
        () => injectHtmlBuildStamp(bad, 'okbuild', { logger: quietLogger, surface: 'unit' }),
        /DRIFT_BAD_PLACEHOLDER/
    );
});

test('storefront index.html: full inject is valid', () => {
    const html = fs.readFileSync(path.join(frontendPath, 'index.html'), 'utf8');
    assert.ok(!html.includes('__F21_BUILD_VALUE__'));
    const out = injectHtmlBuildStamp(html, 'f21_storefront_test', { logger: quietLogger, surface: 'storefront_test' });
    assert.ok(!hasResidualCanonicalPlaceholder(out));
    assert.ok(out.includes("window.__F21_BUILD__ = 'f21_storefront_test'"));
    assert.ok(out.includes('/styles.f21_storefront_test.css'));
    assert.ok(out.includes('/app.f21_storefront_test.js'));
});

test('admin index.html: full inject is valid', () => {
    const html = fs.readFileSync(path.join(frontendPath, 'admin', 'index.html'), 'utf8');
    assert.ok(!html.includes('__F21_BUILD_VALUE__'));
    const out = injectHtmlBuildStamp(html, 'f21_admin_test', { logger: quietLogger, surface: 'admin_test' });
    assert.ok(!hasResidualCanonicalPlaceholder(out));
    assert.ok(out.includes("window.__F21_BUILD__ = 'f21_admin_test'"));
    assert.ok(out.includes('/admin-assets/styles.f21_admin_test.css'));
    assert.ok(out.includes('/admin-assets/app.f21_admin_test.js'));
});

test('priority env over git', () => {
    const prev = process.env.F21_FRONTEND_BUILD;
    process.env.F21_FRONTEND_BUILD = 'env_priority_test';
    delete require.cache[require.resolve('../frontend-build-id')];
    const mod = require('../frontend-build-id');
    const r = mod.resolveFrontendBuildId({
        repoRoot,
        frontendPath,
        logger: { log() {} }
    });
    assert.strictEqual(r.source, 'env');
    assert.strictEqual(r.build, 'env_priority_test');
    if (prev === undefined) delete process.env.F21_FRONTEND_BUILD;
    else process.env.F21_FRONTEND_BUILD = prev;
    delete require.cache[require.resolve('../frontend-build-id')];
});

test('priority git when env unset and repo has git', () => {
    const prev = process.env.F21_FRONTEND_BUILD;
    delete process.env.F21_FRONTEND_BUILD;
    delete require.cache[require.resolve('../frontend-build-id')];
    const mod = require('../frontend-build-id');
    const r = mod.resolveFrontendBuildId({
        repoRoot,
        frontendPath,
        logger: { log() {} }
    });
    assert.strictEqual(r.source, 'git');
    assert.ok(/^[0-9a-f]{4,12}$/.test(r.build), `unexpected build: ${r.build}`);
    if (prev === undefined) delete process.env.F21_FRONTEND_BUILD;
    else process.env.F21_FRONTEND_BUILD = prev;
    delete require.cache[require.resolve('../frontend-build-id')];
});

test('priority file when no git and no env', () => {
    const prev = process.env.F21_FRONTEND_BUILD;
    delete process.env.F21_FRONTEND_BUILD;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f21-fbuild-'));
    fs.writeFileSync(path.join(tmp, 'BUILD_ID'), 'filebuild_v1\n', 'utf8');
    delete require.cache[require.resolve('../frontend-build-id')];
    const mod = require('../frontend-build-id');
    const r = mod.resolveFrontendBuildId({
        repoRoot: tmp,
        frontendPath: tmp,
        logger: { log() {} }
    });
    assert.strictEqual(r.source, 'file');
    assert.strictEqual(r.build, 'filebuild_v1');
    try {
        fs.rmSync(tmp, { recursive: true, force: true });
    } catch (_) {}
    if (prev === undefined) delete process.env.F21_FRONTEND_BUILD;
    else process.env.F21_FRONTEND_BUILD = prev;
    delete require.cache[require.resolve('../frontend-build-id')];
});

test('timestamp_fallback when nothing else', () => {
    const prev = process.env.F21_FRONTEND_BUILD;
    delete process.env.F21_FRONTEND_BUILD;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f21-fbuild-empty-'));
    delete require.cache[require.resolve('../frontend-build-id')];
    const mod = require('../frontend-build-id');
    const r = mod.resolveFrontendBuildId({
        repoRoot: tmp,
        frontendPath: tmp,
        logger: { log() {} }
    });
    assert.strictEqual(r.source, 'timestamp_fallback');
    assert.ok(/^ts_\d+$/.test(r.build));
    try {
        fs.rmSync(tmp, { recursive: true, force: true });
    } catch (_) {}
    if (prev === undefined) delete process.env.F21_FRONTEND_BUILD;
    else process.env.F21_FRONTEND_BUILD = prev;
    delete require.cache[require.resolve('../frontend-build-id')];
});
