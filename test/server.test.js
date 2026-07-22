'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { _test } = require('../index.js');

function makeDatabaseSettings({ vector = false, apiKey = 'old-secret', mode = 'baseline', characterSettings = { old: { enabled: true } }, tableTags = '<content>' } = {}) {
  return {
    shujuku_v120_globalMeta_v1: JSON.stringify({
      vectorMemoryConfigGlobal: {
        enabled: vector,
        embeddingApiKey: apiKey,
        embeddingModel: 'embedding-model',
        topK: 20,
      },
    }),
    shujuku_v120_profile_v1____default____settings: JSON.stringify({
      apiConfig: { url: 'https://example.test/v1', apiKey, model: 'model-a', max_tokens: 1000, temperature: 0.7, requestHeaders: { 'x-test': mode } },
      apiPresets: [{ name: 'Main', apiConfig: { url: 'https://example.test/v1', apiKey, model: 'model-a', max_tokens: 1000, temperature: 0.7, requestHeaders: { 'x-test': mode } } }],
      defaultApiPresetName: 'Main',
      tableApiPreset: 'Main',
      plotApiPreset: 'Main',
      characterSettings,
      tableContextExtractTags: tableTags,
      plotSettings: {
        enabled: true,
        promptPresets: [{ name: 'Time Recall', extractTags: '<content>' }],
        plotWorldbookConfig: { source: 'character', manualSelection: ['worldbook-a'], enabledEntries: {} },
      },
    }),
  };
}

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

function createFixture(database = makeDatabaseSettings()) {
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

test('saveBaseline stores only the selected configuration scope', () => {
  const { paths } = createFixture();
  const baseline = _test.saveBaseline(paths);
  assert.equal(baseline.scope_version, 1);
  assert.equal(baseline.data.profileSettings.apiPresets[0].name, 'Main');
  assert.equal(Object.hasOwn(baseline, 'power_user'), false);
  assert.equal(baseline.target_hash, _test.hashJson(baseline.data));
});

test('restoreBaseline changes only selected settings and preserves character data', () => {
  const { paths } = createFixture(makeDatabaseSettings({ vector: true, apiKey: 'good-secret', characterSettings: { old: { enabled: true } }, tableTags: '<good>' }));
  _test.saveBaseline(paths);

  const changedDatabase = makeDatabaseSettings({ vector: false, apiKey: 'bad-secret', characterSettings: { old: { enabled: true }, newer: { enabled: true } }, tableTags: '<bad>' });
  const changed = makeSettings(changedDatabase);
  changed.power_user.extra = 'must-survive';
  fs.writeFileSync(paths.settingsPath, JSON.stringify(changed), 'utf8');
  const otherHashBefore = _test.hashWithoutTarget(changed);

  const result = _test.restoreBaseline(paths);
  const restored = JSON.parse(fs.readFileSync(paths.settingsPath, 'utf8'));
  const restoredTarget = _test.expandEmbeddedJson(_test.getValueAtPath(restored));
  const restoredProfile = restoredTarget.shujuku_v120_profile_v1____default____settings;
  const restoredGlobal = restoredTarget.shujuku_v120_globalMeta_v1;
  assert.equal(restoredGlobal.vectorMemoryConfigGlobal.enabled, true);
  assert.equal(restoredProfile.apiConfig.apiKey, 'good-secret');
  assert.equal(restoredProfile.tableContextExtractTags, '<good>');
  assert.deepEqual(restoredProfile.characterSettings, { old: { enabled: true }, newer: { enabled: true } });
  assert.equal(_test.hashWithoutTarget(restored), otherHashBefore);
  assert.equal(restored.power_user.extra, 'must-survive');
  assert.equal(fs.existsSync(result.fullBackupPath), true);
});

test('selective restore preserves new presets and table data while restoring rules', () => {
  const baselineDatabase = makeDatabaseSettings({ apiKey: 'good-secret' });
  baselineDatabase.shujuku_v120_profile_v1____default____template = JSON.stringify({
    sheet_a: { content: [['baseline-row']], exportConfig: { enabled: true, keywords: 'saved-rule' } },
  });
  baselineDatabase.shujuku_v120_templatePresets_v1 = JSON.stringify({
    presets: { Saved: { templateStr: { sheet_a: { content: [['baseline-preset-row']], exportConfig: { enabled: true, keywords: 'saved-preset-rule' } } } } },
  });
  const { paths } = createFixture(baselineDatabase);
  _test.saveBaseline(paths);

  const currentDatabase = makeDatabaseSettings({
    apiKey: 'bad-secret',
    characterSettings: { old: { enabled: true }, newer: { enabled: true } },
  });
  const currentProfile = JSON.parse(currentDatabase.shujuku_v120_profile_v1____default____settings);
  currentProfile.apiPresets.push({ name: 'New API', apiConfig: { apiKey: 'new-secret', model: 'new-model' } });
  currentProfile.plotSettings.promptPresets.push({ name: 'New Plot', extractTags: '<new>' });
  currentDatabase.shujuku_v120_profile_v1____default____settings = JSON.stringify(currentProfile);
  currentDatabase.shujuku_v120_profile_v1____default____template = JSON.stringify({
    sheet_a: { content: [['current-row']], exportConfig: { enabled: false, keywords: 'bad-rule' } },
  });
  currentDatabase.shujuku_v120_templatePresets_v1 = JSON.stringify({
    presets: { Saved: { templateStr: { sheet_a: { content: [['current-preset-row']], exportConfig: { enabled: false, keywords: 'bad-preset-rule' } } } } },
  });
  fs.writeFileSync(paths.settingsPath, JSON.stringify(makeSettings(currentDatabase)), 'utf8');

  _test.restoreBaseline(paths);
  const restoredSettings = JSON.parse(fs.readFileSync(paths.settingsPath, 'utf8'));
  const restored = _test.expandEmbeddedJson(_test.getValueAtPath(restoredSettings));
  const profile = restored.shujuku_v120_profile_v1____default____settings;
  const activeTemplate = restored.shujuku_v120_profile_v1____default____template;
  const templatePresets = restored.shujuku_v120_templatePresets_v1;

  assert.equal(profile.apiPresets.find(item => item.name === 'Main').apiConfig.apiKey, 'good-secret');
  assert.equal(profile.apiPresets.some(item => item.name === 'New API'), true);
  assert.equal(profile.plotSettings.promptPresets.some(item => item.name === 'New Plot'), true);
  assert.equal(Object.keys(profile.characterSettings).length, 2);
  assert.deepEqual(activeTemplate.sheet_a.content, [['current-row']]);
  assert.equal(activeTemplate.sheet_a.exportConfig.keywords, 'saved-rule');
  assert.deepEqual(templatePresets.presets.Saved.templateStr.sheet_a.content, [['current-preset-row']]);
  assert.equal(templatePresets.presets.Saved.templateStr.sheet_a.exportConfig.keywords, 'saved-preset-rule');
});

test('rollbackRestore returns to the pre-restore selected configuration', () => {
  const { paths } = createFixture(makeDatabaseSettings({ vector: true, mode: 'baseline' }));
  _test.saveBaseline(paths);
  const beforeRestore = makeSettings(makeDatabaseSettings({ vector: false, mode: 'phone-fallback' }));
  fs.writeFileSync(paths.settingsPath, JSON.stringify(beforeRestore), 'utf8');

  _test.restoreBaseline(paths);
  _test.rollbackRestore(paths);

  const rolledBack = JSON.parse(fs.readFileSync(paths.settingsPath, 'utf8'));
  const rolledBackTarget = _test.expandEmbeddedJson(_test.getValueAtPath(rolledBack));
  assert.equal(rolledBackTarget.shujuku_v120_globalMeta_v1.vectorMemoryConfigGlobal.enabled, false);
  assert.equal(rolledBackTarget.shujuku_v120_profile_v1____default____settings.apiConfig.requestHeaders['x-test'], 'phone-fallback');
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
  const { paths } = createFixture(makeDatabaseSettings({ vector: true }));
  _test.saveBaseline(paths);
  assert.equal(_test.getStatus(paths).current_matches_baseline, true);

  fs.writeFileSync(paths.settingsPath, JSON.stringify(makeSettings(makeDatabaseSettings({ vector: false }))), 'utf8');
  assert.equal(_test.getStatus(paths).current_matches_baseline, false);
});

test('patchSettingsTarget refuses to alter unrelated settings', () => {
  const { paths } = createFixture(makeDatabaseSettings());
  const before = JSON.parse(fs.readFileSync(paths.settingsPath, 'utf8'));
  const beforeOther = _test.hashWithoutTarget(before);
  _test.patchSettingsTarget(paths, _test.getValueAtPath(before), 'test-backup');
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
