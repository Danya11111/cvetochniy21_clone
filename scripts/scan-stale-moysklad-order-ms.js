#!/usr/bin/env node
/**
 * CLI: проверить последние orders с ms_id на существование customerorder в МойСклад.
 * Требует env как у backend (MOYSKLAD_TOKEN, опционально F21_SQLITE_PATH).
 *
 *   node scripts/scan-stale-moysklad-order-ms.js [limit]
 */
'use strict';

const path = require('path');

async function main() {
    const db = require(path.join(__dirname, '..', 'backend', 'db'));
    await db.awaitMigrations;

    const { scanStaleMsOrderLinks } = require(path.join(__dirname, '..', 'backend', 'moysklad'));
    const limit = Number(process.argv[2]) || 50;
    const result = await scanStaleMsOrderLinks({ limit });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 2;
}

main().catch(e => {
    process.stderr.write(String(e && e.stack ? e.stack : e) + '\n');
    process.exit(1);
});
