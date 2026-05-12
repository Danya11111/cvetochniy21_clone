'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const files = fs.readdirSync(dir).filter(f => f.endsWith('.test.js') && f !== 'run-all.js').sort();

let code = 0;
for (const f of files) {
    const r = spawnSync(process.execPath, [path.join(dir, f)], { stdio: 'inherit' });
    if (r.status !== 0) code = r.status || 1;
}
process.exit(code);
