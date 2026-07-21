'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { _test } = require('../index.js');

function makeSettings(database, marker = 'keep-me') {
  return {
    firstRun: false,
    power_user: { theme: 'test', marker },
    extension_settings: {
      unrelated_extension: { enabled: true },
      __userscripts: {
        [_test.TARGET_KEY]: database,
      },
    },
  };
}

function createFixture(database = { profile: { vector: false, apiKey: 'old-secret' } }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shujuku-vault-'));
  const backupsDirectory = path.join(root, 'backups');
  const vaultDirectory = path.join(backupsDirectory, 'shujuku-settings-vault');
  fs.mkdirSync(backupsDirectory, { recursive: true });
  const paths = {
    settingsPath: path.join(root, 'settings.json'),
    backupsDirectory,
    vaultDirectory,
    baselinePath: path.join(vaultDirectory, 'baseline.json'),
    rollbackPath: path.join(vaultDirectory, 'last-rollback.json'),
    auditPath: path.join(vaultDirectory, 'audit.jsonl'),
  };
  fs.writeFileSync(paths.settingsPath, `${JSON.stringify(makeSettings(database), null, 2)}\n`, 'utf8');
  return { root, paths };
}

test('saveBaseline stores only the scoped database block', () => {
  const { paths } = createFixture();
  const baseline = _test.saveBaseline(paths);
  assert.deepEqual(baseline.data, { profile: { vector: false, apiKey: 'old-secret' } });
  assert.equal(Object.hasOwn(baseline, 'power_user'), false);
  assert.equal(baseline.target_hash, _test.hashJson(baseline.data));
});

test('restoreBaseline changes only the database block and creates a full backup', () => {
  const { paths } = createFixture({ profile: { vector: true, apiKey: 'good-secret' } });
  _test.saveBaseline(paths);

  const changed = makeSettings({ profile: { vector: false, apiKey: 'bad-secret' } });
  changed.power_user.extra = 'must-survive';
  fs.writeFileSync(paths.settingsPath, JSON.stringify(changed), 'utf8');
  const otherHashBefore = _test.hashWithoutTarget(changed);

  const result = _test.restoreBaseline(paths);
  const restored = JSON.parse(fs.readFileSync(paths.settingsPath, 'utf8'));
  assert.deepEqual(_test.getValueAtPath(restored), { profile: { vector: true, apiKey: 'good-secret' } });
  assert.equal(_test.hashWithoutTarget(restored), otherHashBefore);
  assert.equal(restored.power_user.extra, 'must-survive');
  assert.equal(fs.existsSync(result.fullBackupPath), true);
});

test('rollbackRestore returns to the pre-restore database configuration', () => {
  const { paths } = createFixture({ profile: { vector: true, mode: 'baseline' } });
  _test.saveBaseline(paths);
  const beforeRestore = makeSettings({ profile: { vector: false, mode: 'phone-fallback' } });
  fs.writeFileSync(paths.settingsPath, JSON.stringify(beforeRestore), 'utf8');

  _test.restoreBaseline(paths);
  _test.rollbackRestore(paths);

  const rolledBack = JSON.parse(fs.readFileSync(paths.settingsPath, 'utf8'));
  assert.deepEqual(_test.getValueAtPath(rolledBack), { profile: { vector: false, mode: 'phone-fallback' } });
});

test('diffValues masks sensitive values', () => {
  const result = _test.diffValues(
    { apiKey: 'secret-one', endpoint: 'https://old.example.test', enabled: false },
    { apiKey: 'secret-two', endpoint: 'https://new.example.test', enabled: true },
  );
  const keyChange = result.details.find(item => item.path === 'apiKey');
  assert.equal(keyChange.before, '已设置（内容已隐藏）');
  assert.equal(keyChange.after, '已设置（内容已隐藏）');
  assert.equal(JSON.stringify(result).includes('secret-one'), false);
  assert.equal(JSON.stringify(result).includes('secret-two'), false);
});

test('getStatus reports whether current settings match the baseline', () => {
  const { paths } = createFixture({ profile: { vector: true } });
  _test.saveBaseline(paths);
  assert.equal(_test.getStatus(paths).current_matches_baseline, true);

  fs.writeFileSync(paths.settingsPath, JSON.stringify(makeSettings({ profile: { vector: false } })), 'utf8');
  assert.equal(_test.getStatus(paths).current_matches_baseline, false);
});

test('patchSettingsTarget refuses to alter unrelated settings', () => {
  const { paths } = createFixture({ profile: { vector: false } });
  const before = JSON.parse(fs.readFileSync(paths.settingsPath, 'utf8'));
  const beforeOther = _test.hashWithoutTarget(before);
  _test.patchSettingsTarget(paths, { profile: { vector: true } }, 'test-backup');
  const after = JSON.parse(fs.readFileSync(paths.settingsPath, 'utf8'));
  assert.equal(_test.hashWithoutTarget(after), beforeOther);
});

test('pruneOwnedFiles removes only the oldest matching plugin files', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shujuku-vault-prune-'));
  const pluginFiles = [];
  for (let index = 0; index < 8; index += 1) {
    const filePath = path.join(directory, `manual-before-shujuku-vault-restore-${index}.json`);
    fs.writeFileSync(filePath, '{}', 'utf8');
    const modified = new Date(2026, 0, 1, 0, 0, index);
    fs.utimesSync(filePath, modified, modified);
    pluginFiles.push(filePath);
  }
  const nativeBackup = path.join(directory, 'settings_default-user_20260722-062625.json');
  const unrelated = path.join(directory, 'manual-user-backup.json');
  fs.writeFileSync(nativeBackup, '{}', 'utf8');
  fs.writeFileSync(unrelated, '{}', 'utf8');

  const removed = _test.pruneOwnedFiles(
    directory,
    /^manual-before-shujuku-vault-(?:restore|undo)-.+\.json$/i,
    5,
  );

  const remainingPluginFiles = pluginFiles.filter(filePath => fs.existsSync(filePath));
  assert.equal(removed.length, 3);
  assert.equal(remainingPluginFiles.length, 5);
  assert.equal(fs.existsSync(nativeBackup), true);
  assert.equal(fs.existsSync(unrelated), true);
  assert.deepEqual(
    remainingPluginFiles.map(filePath => path.basename(filePath)),
    pluginFiles.slice(3).map(filePath => path.basename(filePath)),
  );
});

test('buildFriendlyChanges reads API preset names from embedded JSON without exposing keys', () => {
  const makeTarget = (names, vectorEnabled, apiKey) => ({
    shujuku_v120_globalMeta_v1: JSON.stringify({
      vectorMemoryConfigGlobal: {
        enabled: vectorEnabled,
        embeddingApiKey: apiKey,
        embeddingModel: 'embedding-model',
      },
    }),
    shujuku_v120_profile_v1____default____settings: JSON.stringify({
      apiPresets: names.map(name => ({ name, apiConfig: { apiKey } })),
      autoUpdateEnabled: true,
    }),
  });

  const result = _test.buildFriendlyChanges(
    makeTarget(['主线路', '备用线路'], true, 'secret-before'),
    makeTarget(['主线路'], false, 'secret-after'),
  );

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('备用线路'), true);
  assert.equal(serialized.includes('向量记忆'), true);
  assert.equal(serialized.includes('secret-before'), false);
  assert.equal(serialized.includes('secret-after'), false);
  assert.equal(result.important_count >= 2, true);
});
