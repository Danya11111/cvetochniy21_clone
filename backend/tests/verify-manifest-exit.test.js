/**
 * Регрессия: verify-production-manifest.js должен завершаться 0 на чистом дереве.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const script = path.join(__dirname, '..', '..', 'scripts', 'verify-production-manifest.js');

function test(name, fn) {
    try {
        fn();
        process.stdout.write(`PASS ${name}\n`);
    } catch (e) {
        process.stderr.write(`FAIL ${name}: ${e.message}\n`);
        process.exitCode = 1;
    }
}

test('verify-production-manifest exits 0', () => {
    const r = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    if (r.status !== 0) {
        throw new Error(`exit ${r.status} stderr=${r.stderr} stdout=${r.stdout}`);
    }
});
