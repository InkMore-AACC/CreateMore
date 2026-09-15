'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { validateEnvironment } = require('../app/e2e.cjs');

const appDir = path.resolve(__dirname, '..');
const cleanService = () => ({ current: null, sessions: new Map(), queue: { tasks: [] } });
test('Electron E2E requires explicit flag and isolated test data', () => {
  const input = { appDir, dataDir: path.join(appDir, '.test-output', 'fresh-data'), service: cleanService() };
  assert.throws(() => validateEnvironment(input, []), /explicit/);
  assert.equal(validateEnvironment(input, ['--e2e-test']), path.join(appDir, '.test-output'));
  for (const dataDir of [appDir, path.dirname(appDir), path.join(appDir, '.test-output'), path.join(appDir, '.test-output-other', 'data')]) {
    assert.throws(() => validateEnvironment({ ...input, dataDir }, ['--e2e-test']), /isolated/);
  }
});
test('Electron E2E refuses user sessions and persisted tasks before any mutation', () => {
  const input = { appDir, dataDir: path.join(appDir, '.test-output', 'fresh-data'), service: cleanService() };
  input.service.current = { id: 'existing' }; assert.throws(() => validateEnvironment(input, ['--e2e-test']), /existing/);
  input.service.current = null; input.service.sessions.set('existing', {}); assert.throws(() => validateEnvironment(input, ['--e2e-test']), /existing/);
  input.service.sessions.clear(); input.service.queue.tasks.push({ id: 'persisted' }); assert.throws(() => validateEnvironment(input, ['--e2e-test']), /empty task/);
});
