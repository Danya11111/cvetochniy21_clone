'use strict';

const assert = require('assert');
const { normalizeClientsSearchQ, buildUsersSearchSqlAndParams } = require('../admin-mini-v2-service');

assert.strictEqual(normalizeClientsSearchQ('  @User '), 'user');
assert.strictEqual(normalizeClientsSearchQ('@@@Danya'), 'danya');

const withClause = buildUsersSearchSqlAndParams('u', 'Иван');
assert.ok(withClause.clause.includes('AND'));
assert.strictEqual(withClause.params.length, 5);

const empty = buildUsersSearchSqlAndParams('u', '   ');
assert.strictEqual(empty.clause.trim(), '');
assert.strictEqual(empty.params.length, 0);

process.stdout.write('PASS admin-clients-search\n');
