'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const PLUGIN_ID = 'shujuku-settings-vault';
const VERSION = '0.1.1';
const SCHEMA_VERSION = 1;
const TARGET_KEY = 'shujuku_v120__userscript_settings_v1';
const TARGET_PATH = ['extension_settings', '__userscripts', TARGET_KEY];
const MAX_AUDIT_ENTRIES = 200;
const MAX_REPORT_DETAILS = 200;
const MAX_TIMELINE_FILES = 24;
const MAX_SAVED_REPORTS = 20;
const MAX_BASELINE_HISTORY = 10;
const MAX_FULL_SETTINGS_BACKUPS = 5;
const SENSITIVE_FIELD = /(?:api.?key|token|secret|password|authorization|credential|access.?key|cookie|session|email|密钥|令牌|密码|凭据|邮箱)/i;

function nowIso() {
  return new Date().toISOString();
}

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[-:.]/g, '');
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function expandEmbeddedJson(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return expandEmbeddedJson(JSON.parse(trimmed));
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(item => expandEmbeddedJson(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandEmbeddedJson(item)]));
  }
  return value;
}

function hashJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function hashPrefix(value) {
  return hashJson(value).slice(0, 12);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeFileDurably(filePath, content) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  const handle = fs.openSync(temporaryPath, 'w');
  try {
    fs.writeFileSync(handle, content, 'utf8');
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }

  try {
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    if (!fs.existsSync(temporaryPath)) throw error;
    fs.copyFileSync(temporaryPath, filePath);
    fs.rmSync(temporaryPath, { force: true });
  }
}

function writeJson(filePath, value) {
  writeFileDurably(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function pruneOwnedFiles(directory, matcher, maxCount) {
  if (!fs.existsSync(directory)) return [];
  const matches = fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && matcher.test(entry.name))
    .map(entry => {
      const filePath = path.join(directory, entry.name);
      return { filePath, name: entry.name, modifiedAt: fs.statSync(filePath).mtimeMs };
    })
    .sort((left, right) => right.modifiedAt - left.modifiedAt);

  const removed = [];
  for (const oldFile of matches.slice(maxCount)) {
    fs.rmSync(oldFile.filePath, { force: true });
    removed.push(oldFile.name);
  }
  return removed;
}

function getValueAtPath(root, segments = TARGET_PATH) {
  let current = root;
  for (const segment of segments) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function setValueAtPath(root, value, segments = TARGET_PATH) {
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    if (!current[segment] || typeof current[segment] !== 'object' || Array.isArray(current[segment])) {
      current[segment] = {};
    }
    current = current[segment];
  }
  current[segments.at(-1)] = cloneJson(value);
}

function deleteValueAtPath(root, segments = TARGET_PATH) {
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    if (!current || typeof current !== 'object') return;
    current = current[segment];
  }
  if (current && typeof current === 'object') delete current[segments.at(-1)];
}

function hashWithoutTarget(settings) {
  const clone = cloneJson(settings);
  deleteValueAtPath(clone);
  return hashJson(clone);
}

function getUserPaths(request) {
  const directories = request?.user?.directories;
  if (!directories?.root || !directories?.backups) {
    throw new Error('SillyTavern user directories are unavailable.');
  }

  const settingsPath = path.join(directories.root, 'settings.json');
  const vaultDirectory = path.join(directories.backups, PLUGIN_ID);
  return {
    settingsPath,
    backupsDirectory: directories.backups,
    vaultDirectory,
    baselinePath: path.join(vaultDirectory, 'baseline.json'),
    rollbackPath: path.join(vaultDirectory, 'last-rollback.json'),
    auditPath: path.join(vaultDirectory, 'audit.jsonl'),
  };
}

function readSettings(paths) {
  if (!fs.existsSync(paths.settingsPath)) throw new Error('settings.json does not exist.');
  const settings = readJson(paths.settingsPath);
  const target = getValueAtPath(settings);
  if (target === undefined) throw new Error(`Database settings key ${TARGET_KEY} was not found.`);
  return { settings, target };
}

function readBaseline(paths) {
  if (!fs.existsSync(paths.baselinePath)) return null;
  const baseline = readJson(paths.baselinePath);
  if (baseline?.schema_version !== SCHEMA_VERSION || baseline?.target_key !== TARGET_KEY || baseline?.data === undefined) {
    throw new Error('The saved baseline file is invalid.');
  }
  if (baseline.target_hash !== hashJson(baseline.data)) {
    throw new Error('The saved baseline failed its integrity check.');
  }
  return baseline;
}

function readAudit(paths) {
  if (!fs.existsSync(paths.auditPath)) return [];
  return fs.readFileSync(paths.auditPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function appendAudit(paths, event) {
  const entries = [...readAudit(paths), { at: nowIso(), plugin_version: VERSION, ...event }]
    .slice(-MAX_AUDIT_ENTRIES);
  writeFileDurably(paths.auditPath, `${entries.map(item => JSON.stringify(item)).join('\n')}\n`);
  return entries.at(-1);
}

function describeValue(value, fieldPath) {
  if (SENSITIVE_FIELD.test(fieldPath)) {
    const present = value !== null && value !== undefined && value !== '';
    return present ? '已设置（内容已隐藏）' : '空';
  }
  if (value === undefined) return '不存在';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `数组（${value.length} 项）`;
  if (typeof value === 'object') return `对象（${Object.keys(value).length} 项）`;
  if (typeof value === 'boolean') return value ? '开启' : '关闭';
  if (typeof value === 'number') return String(value);
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return '空字符串';
  return text.length > 90 ? `${text.slice(0, 87)}...` : text;
}

function diffValues(before, after, options = {}) {
  const maxDetails = options.maxDetails ?? MAX_REPORT_DETAILS;
  const details = [];
  let total = 0;

  function add(pathName, kind, oldValue, newValue) {
    total += 1;
    if (details.length >= maxDetails) return;
    details.push({
      path: pathName || '(根设置)',
      kind,
      before: describeValue(oldValue, pathName),
      after: describeValue(newValue, pathName),
    });
  }

  function walk(oldValue, newValue, currentPath) {
    if (Object.is(oldValue, newValue)) return;
    const oldObject = oldValue && typeof oldValue === 'object';
    const newObject = newValue && typeof newValue === 'object';
    if (!oldObject || !newObject || Array.isArray(oldValue) !== Array.isArray(newValue)) {
      add(currentPath, oldValue === undefined ? 'added' : newValue === undefined ? 'removed' : 'changed', oldValue, newValue);
      return;
    }

    if (Array.isArray(oldValue) && Array.isArray(newValue)) {
      const length = Math.max(oldValue.length, newValue.length);
      for (let index = 0; index < length; index += 1) {
        walk(oldValue[index], newValue[index], `${currentPath}[${index}]`);
      }
      return;
    }

    const keys = new Set([...Object.keys(oldValue), ...Object.keys(newValue)]);
    for (const key of [...keys].sort((left, right) => left.localeCompare(right))) {
      walk(oldValue[key], newValue[key], currentPath ? `${currentPath}.${key}` : key);
    }
  }

  walk(before, after, '');
  return { total, truncated: total > details.length, details };
}

function summarizeDiff(diff) {
  const summary = { added: 0, removed: 0, changed: 0 };
  for (const item of diff.details) summary[item.kind] = (summary[item.kind] || 0) + 1;
  return { total: diff.total, truncated: diff.truncated, ...summary };
}

function isConfigured(...values) {
  return values.some(value => typeof value === 'string' ? value.trim().length > 0 : value !== null && value !== undefined);
}

function buildFriendlySnapshot(target) {
  const expanded = expandEmbeddedJson(target) ?? {};
  const meta = expanded.shujuku_v120_globalMeta_v1 ?? {};
  const settings = expanded.shujuku_v120_profile_v1____default____settings ?? {};
  const vector = meta.vectorMemoryConfigGlobal ?? {};
  const presets = Array.isArray(settings.apiPresets) ? settings.apiPresets : [];
  const presetNames = presets.map((preset, index) => {
    const name = typeof preset?.name === 'string' ? preset.name.trim() : '';
    return name || `未命名 API 配置 ${index + 1}`;
  });
  const templatePresets = expanded.shujuku_v120_templatePresets_v1?.presets ?? {};
  const characterSettings = settings.characterSettings ?? {};
  const chatBindings = settings.apiPresetBindingsByChat ?? {};

  return {
    apiPresetNames: presetNames,
    defaultApiPresetName: settings.defaultApiPresetName || null,
    tableApiPreset: settings.tableApiPreset || null,
    plotApiPreset: settings.plotApiPreset || null,
    keywordApiPreset: vector.keywordApiPreset || null,
    contentOptimizationApiPreset: settings.contentOptimizationSettings?.apiPreset || null,
    streamingEnabled: Boolean(settings.streamingEnabled),
    autoUpdateEnabled: Boolean(settings.autoUpdateEnabled),
    vectorEnabled: Boolean(vector.enabled),
    summaryVectorEnabled: Boolean(settings.summaryVectorIndexModeDefault || meta.summaryVectorIndexModeGlobal),
    embeddingConfigured: isConfigured(vector.embeddingEndpoint, vector.embeddingApiKey, vector.embeddingModel),
    embeddingModel: vector.embeddingModel || null,
    rerankConfigured: isConfigured(vector.rerankEndpoint, vector.rerankApiKey, vector.rerankModel),
    rerankModel: vector.rerankModel || null,
    vectorTopK: vector.topK ?? null,
    vectorMinScore: vector.minScore ?? null,
    plotEnabled: Boolean(settings.plotSettings?.enabled || meta.plotEnabledGlobal),
    contentOptimizationEnabled: Boolean(settings.contentOptimizationSettings?.enabled),
    autoMergeEnabled: Boolean(settings.autoMergeEnabled),
    characterOverrideCount: Object.keys(characterSettings).length,
    chatBindingCount: Object.keys(chatBindings).length,
    templatePresetCount: Object.keys(templatePresets).length,
    windowStateCount: Object.keys(expanded.shujuku_v120_windowStates ?? {}).length,
    themeEntryCount: Object.keys(expanded.shujuku_v120_ui_theme_v1 ?? {}).length,
  };
}

function addFriendlyChange(changes, category, title, before, after, impact, level = 'normal') {
  if (Object.is(before, after)) return;
  changes.push({ category, title, before, after, impact, level });
}

function boolText(value) {
  return value ? '已开启' : '已关闭';
}

function textOrUnset(value) {
  return value === null || value === undefined || value === '' ? '未设置' : String(value);
}

function buildFriendlyChanges(beforeTarget, afterTarget) {
  const before = buildFriendlySnapshot(beforeTarget);
  const after = buildFriendlySnapshot(afterTarget);
  const changes = [];
  const beforeNames = new Set(before.apiPresetNames);
  const afterNames = new Set(after.apiPresetNames);
  const removedNames = before.apiPresetNames.filter(name => !afterNames.has(name));
  const addedNames = after.apiPresetNames.filter(name => !beforeNames.has(name));

  if (removedNames.length || addedNames.length) {
    changes.push({
      category: 'API 配置',
      title: 'API 预设列表发生变化',
      before: `${before.apiPresetNames.length} 个：${before.apiPresetNames.join('、') || '无'}`,
      after: `${after.apiPresetNames.length} 个：${after.apiPresetNames.join('、') || '无'}`,
      impact: [
        removedNames.length ? `消失：${removedNames.join('、')}` : '',
        addedNames.length ? `新增：${addedNames.join('、')}` : '',
      ].filter(Boolean).join('；'),
      level: removedNames.length ? 'important' : 'normal',
    });
  }

  addFriendlyChange(changes, 'API 配置', '默认 API 预设', textOrUnset(before.defaultApiPresetName), textOrUnset(after.defaultApiPresetName), '会影响数据库默认调用的接口。', 'important');
  addFriendlyChange(changes, 'API 配置', '表格更新 API 预设', textOrUnset(before.tableApiPreset), textOrUnset(after.tableApiPreset), '会影响自动填表和表格更新。', 'important');
  addFriendlyChange(changes, 'API 配置', '剧情分析 API 预设', textOrUnset(before.plotApiPreset), textOrUnset(after.plotApiPreset), '会影响剧情分析功能。');
  addFriendlyChange(changes, '向量记忆', '关键词生成 API 预设', textOrUnset(before.keywordApiPreset), textOrUnset(after.keywordApiPreset), '会影响向量记忆的关键词生成。');
  addFriendlyChange(changes, '内容优化', '内容优化 API 预设', textOrUnset(before.contentOptimizationApiPreset), textOrUnset(after.contentOptimizationApiPreset), '会影响内容优化调用。');
  addFriendlyChange(changes, 'API 配置', '流式传输', boolText(before.streamingEnabled), boolText(after.streamingEnabled), '只影响数据库调用时是否流式返回。');
  addFriendlyChange(changes, '数据库更新', '自动更新', boolText(before.autoUpdateEnabled), boolText(after.autoUpdateEnabled), '关闭后数据库不会按原规则自动更新。', 'important');
  addFriendlyChange(changes, '向量记忆', '向量记忆', boolText(before.vectorEnabled), boolText(after.vectorEnabled), '关闭后将无法按原设置进行向量检索。', 'important');
  addFriendlyChange(changes, '向量记忆', '摘要向量索引', boolText(before.summaryVectorEnabled), boolText(after.summaryVectorEnabled), '会影响摘要进入向量索引。');
  addFriendlyChange(changes, '向量记忆', 'Embedding 配置', before.embeddingConfigured ? `已配置${before.embeddingModel ? `（${before.embeddingModel}）` : ''}` : '未配置', after.embeddingConfigured ? `已配置${after.embeddingModel ? `（${after.embeddingModel}）` : ''}` : '未配置', '报告不会显示 Embedding 地址或 Key。', 'important');
  addFriendlyChange(changes, '向量记忆', 'Rerank 配置', before.rerankConfigured ? `已配置${before.rerankModel ? `（${before.rerankModel}）` : ''}` : '未配置', after.rerankConfigured ? `已配置${after.rerankModel ? `（${after.rerankModel}）` : ''}` : '未配置', '报告不会显示 Rerank 地址或 Key。', 'important');
  addFriendlyChange(changes, '向量记忆', '召回数量 Top K', textOrUnset(before.vectorTopK), textOrUnset(after.vectorTopK), '决定向量检索初步取回多少条内容。');
  addFriendlyChange(changes, '向量记忆', '最低相似度', textOrUnset(before.vectorMinScore), textOrUnset(after.vectorMinScore), '决定相似度过低的内容是否被过滤。');
  addFriendlyChange(changes, '剧情分析', '剧情分析功能', boolText(before.plotEnabled), boolText(after.plotEnabled), '关闭后剧情分析不会按原设置运行。');
  addFriendlyChange(changes, '内容优化', '内容优化功能', boolText(before.contentOptimizationEnabled), boolText(after.contentOptimizationEnabled), '关闭后内容优化不会自动运行。');
  addFriendlyChange(changes, '摘要合并', '自动合并', boolText(before.autoMergeEnabled), boolText(after.autoMergeEnabled), '会影响数据库摘要自动合并。');
  addFriendlyChange(changes, '独立设置', '角色独立设置数量', `${before.characterOverrideCount} 份`, `${after.characterOverrideCount} 份`, '数量减少可能表示某些角色的独立设置丢失。', after.characterOverrideCount < before.characterOverrideCount ? 'important' : 'normal');
  addFriendlyChange(changes, '独立设置', '聊天 API 绑定数量', `${before.chatBindingCount} 份`, `${after.chatBindingCount} 份`, '数量减少可能表示聊天绑定的 API 预设丢失。', after.chatBindingCount < before.chatBindingCount ? 'important' : 'normal');
  addFriendlyChange(changes, '模板', '表格模板预设数量', `${before.templatePresetCount} 套`, `${after.templatePresetCount} 套`, '数量减少可能表示后来保存的表格模板丢失。', after.templatePresetCount < before.templatePresetCount ? 'important' : 'normal');
  addFriendlyChange(changes, '界面', '窗口状态数量', `${before.windowStateCount} 项`, `${after.windowStateCount} 项`, '通常只影响数据库窗口的位置和大小。');
  addFriendlyChange(changes, '界面', '主题设置数量', `${before.themeEntryCount} 项`, `${after.themeEntryCount} 项`, '通常只影响数据库界面外观。');

  return {
    changes,
    important_count: changes.filter(item => item.level === 'important').length,
    normal_count: changes.filter(item => item.level !== 'important').length,
    recommendation: changes.some(item => item.level === 'important') ? '建议检查后恢复基准配置。' : changes.length ? '发现普通设置变化，请确认是否符合预期。' : '当前主要设置与基准一致。',
  };
}

function makeFullSettingsBackup(paths, label) {
  const name = `${label}-${timestampForFile()}.json`;
  const destination = path.join(paths.backupsDirectory, name);
  fs.copyFileSync(paths.settingsPath, destination);
  pruneOwnedFiles(
    paths.backupsDirectory,
    /^manual-before-shujuku-vault-(?:restore|undo)-.+\.json$/i,
    MAX_FULL_SETTINGS_BACKUPS,
  );
  return destination;
}

function patchSettingsTarget(paths, replacement, backupLabel) {
  const { settings, target: previousTarget } = readSettings(paths);
  const nonTargetBefore = hashWithoutTarget(settings);
  const fullBackupPath = makeFullSettingsBackup(paths, backupLabel);
  setValueAtPath(settings, replacement);
  const nonTargetAfter = hashWithoutTarget(settings);
  if (nonTargetBefore !== nonTargetAfter) throw new Error('Non-database settings changed before write; restore was cancelled.');

  writeJson(paths.settingsPath, settings);

  const verifySettings = readJson(paths.settingsPath);
  const verifyTarget = getValueAtPath(verifySettings);
  if (hashJson(verifyTarget) !== hashJson(replacement)) {
    fs.copyFileSync(fullBackupPath, paths.settingsPath);
    throw new Error('Database settings verification failed; the pre-restore file was put back.');
  }
  if (hashWithoutTarget(verifySettings) !== nonTargetBefore) {
    fs.copyFileSync(fullBackupPath, paths.settingsPath);
    throw new Error('Non-database settings verification failed; the pre-restore file was put back.');
  }

  return { previousTarget, fullBackupPath, targetHash: hashJson(verifyTarget) };
}

function saveBaseline(paths) {
  const { target } = readSettings(paths);
  fs.mkdirSync(paths.vaultDirectory, { recursive: true });
  const previous = readBaseline(paths);
  if (previous) {
    const historyPath = path.join(paths.vaultDirectory, `baseline-${timestampForFile()}.json`);
    writeJson(historyPath, previous);
    pruneOwnedFiles(paths.vaultDirectory, /^baseline-.+\.json$/i, MAX_BASELINE_HISTORY);
  }

  const settingsStat = fs.statSync(paths.settingsPath);
  const baseline = {
    schema_version: SCHEMA_VERSION,
    plugin_version: VERSION,
    target_key: TARGET_KEY,
    created_at: nowIso(),
    source_settings_modified_at: settingsStat.mtime.toISOString(),
    target_hash: hashJson(target),
    data: cloneJson(target),
  };
  writeJson(paths.baselinePath, baseline);
  appendAudit(paths, {
    action: 'baseline_saved',
    target_hash: baseline.target_hash,
    replaced_previous_baseline: Boolean(previous),
  });
  return baseline;
}

function restoreBaseline(paths) {
  const baseline = readBaseline(paths);
  if (!baseline) throw new Error('No baseline has been saved yet.');
  const { target: currentTarget } = readSettings(paths);
  const difference = diffValues(currentTarget, baseline.data);
  const rollback = {
    schema_version: SCHEMA_VERSION,
    plugin_version: VERSION,
    target_key: TARGET_KEY,
    created_at: nowIso(),
    target_hash: hashJson(currentTarget),
    data: cloneJson(currentTarget),
  };
  fs.mkdirSync(paths.vaultDirectory, { recursive: true });
  writeJson(paths.rollbackPath, rollback);
  const result = patchSettingsTarget(paths, baseline.data, 'manual-before-shujuku-vault-restore');
  appendAudit(paths, {
    action: 'baseline_restored',
    from_hash: hashJson(currentTarget),
    to_hash: baseline.target_hash,
    full_backup: path.basename(result.fullBackupPath),
    changes: summarizeDiff(difference),
  });
  return { ...result, difference };
}

function rollbackRestore(paths) {
  if (!fs.existsSync(paths.rollbackPath)) throw new Error('There is no restore operation to undo.');
  const rollback = readJson(paths.rollbackPath);
  if (rollback?.target_key !== TARGET_KEY || rollback?.data === undefined || rollback?.target_hash !== hashJson(rollback.data)) {
    throw new Error('The rollback file failed its integrity check.');
  }
  const { target: currentTarget } = readSettings(paths);
  const difference = diffValues(currentTarget, rollback.data);
  const result = patchSettingsTarget(paths, rollback.data, 'manual-before-shujuku-vault-undo');
  appendAudit(paths, {
    action: 'restore_undone',
    from_hash: hashJson(currentTarget),
    to_hash: rollback.target_hash,
    full_backup: path.basename(result.fullBackupPath),
    changes: summarizeDiff(difference),
  });
  return { ...result, difference };
}

function getStatus(paths) {
  const { target } = readSettings(paths);
  const baseline = readBaseline(paths);
  const audit = readAudit(paths);
  const currentHash = hashJson(target);
  return {
    ok: true,
    version: VERSION,
    target_key: TARGET_KEY,
    baseline_exists: Boolean(baseline),
    baseline_created_at: baseline?.created_at ?? null,
    current_matches_baseline: baseline ? currentHash === baseline.target_hash : null,
    current_hash: currentHash.slice(0, 12),
    baseline_hash: baseline?.target_hash?.slice(0, 12) ?? null,
    current_settings_modified_at: fs.statSync(paths.settingsPath).mtime.toISOString(),
    rollback_available: fs.existsSync(paths.rollbackPath),
    last_action: audit.at(-1) ?? null,
  };
}

function listSettingsBackups(paths) {
  if (!fs.existsSync(paths.backupsDirectory)) return [];
  return fs.readdirSync(paths.backupsDirectory, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^settings_.+_\d{8}-\d{6}\.json$/i.test(entry.name))
    .map(entry => {
      const filePath = path.join(paths.backupsDirectory, entry.name);
      const stat = fs.statSync(filePath);
      return { filePath, name: entry.name, modifiedAt: stat.mtime };
    })
    .sort((left, right) => left.modifiedAt - right.modifiedAt)
    .slice(-MAX_TIMELINE_FILES);
}

function buildTimeline(paths) {
  const transitions = [];
  let previous = null;
  for (const file of listSettingsBackups(paths)) {
    try {
      const target = getValueAtPath(readJson(file.filePath));
      if (target === undefined) continue;
      const hash = hashJson(target);
      if (!previous) {
        previous = { ...file, hash, target };
        continue;
      }
      if (previous.hash !== hash) {
        const difference = diffValues(expandEmbeddedJson(previous.target), expandEmbeddedJson(target), { maxDetails: 30 });
        const friendly = buildFriendlyChanges(previous.target, target);
        transitions.push({
          from_file: previous.name,
          to_file: file.name,
          detected_at: file.modifiedAt.toISOString(),
          from_hash: previous.hash.slice(0, 12),
          to_hash: hash.slice(0, 12),
          changes: summarizeDiff(difference),
          friendly,
          details: difference.details,
        });
      }
      previous = { ...file, hash, target };
    } catch {
      // Ignore invalid or unrelated SillyTavern backup files.
    }
  }
  return transitions.slice(-12);
}

function buildReport(paths) {
  const { target } = readSettings(paths);
  const baseline = readBaseline(paths);
  const comparison = baseline ? diffValues(expandEmbeddedJson(baseline.data), expandEmbeddedJson(target)) : null;
  const friendly = baseline ? buildFriendlyChanges(baseline.data, target) : null;
  return {
    generated_at: nowIso(),
    plugin_version: VERSION,
    target_key: TARGET_KEY,
    baseline: baseline ? {
      created_at: baseline.created_at,
      hash: baseline.target_hash.slice(0, 12),
    } : null,
    current: {
      hash: hashPrefix(target),
      settings_modified_at: fs.statSync(paths.settingsPath).mtime.toISOString(),
    },
    comparison: comparison ? {
      summary: summarizeDiff(comparison),
      friendly,
      details: comparison.details,
    } : null,
    timeline: buildTimeline(paths),
    actions: readAudit(paths).slice(-50),
    privacy: 'Sensitive values are masked. This report never includes stored API keys, tokens, passwords, or credentials.',
  };
}

function saveReport(paths, report) {
  const reportsDirectory = path.join(paths.vaultDirectory, 'reports');
  fs.mkdirSync(reportsDirectory, { recursive: true });
  const reportPath = path.join(reportsDirectory, `report-${timestampForFile()}.json`);
  writeJson(reportPath, report);
  pruneOwnedFiles(reportsDirectory, /^report-.+\.json$/i, MAX_SAVED_REPORTS);
  return path.basename(reportPath);
}

async function runGit(repositoryPath, args) {
  const result = await execFileAsync('git', ['-C', repositoryPath, ...args], {
    windowsHide: true,
    timeout: 90_000,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim();
}

async function updateBackendPlugin() {
  const repositoryPath = __dirname;
  if (!fs.existsSync(path.join(repositoryPath, '.git'))) {
    return { ok: false, update_supported: false, error: '后端不是通过 Git 安装，无法使用面板更新。' };
  }
  const dirty = await runGit(repositoryPath, ['status', '--porcelain']);
  if (dirty) {
    return { ok: false, update_supported: true, error: '后端目录存在未提交修改，为避免覆盖文件，已取消更新。' };
  }

  const before = await runGit(repositoryPath, ['rev-parse', 'HEAD']);
  await runGit(repositoryPath, ['fetch', '--quiet', 'origin']);
  let upstream;
  try {
    upstream = await runGit(repositoryPath, ['rev-parse', '--abbrev-ref', '@{u}']);
  } catch {
    upstream = 'origin/main';
  }
  const behind = Number(await runGit(repositoryPath, ['rev-list', '--count', `HEAD..${upstream}`])) || 0;
  if (behind === 0) {
    return { ok: true, updated: false, current_commit: before.slice(0, 7), restart_required: false };
  }

  await runGit(repositoryPath, ['pull', '--ff-only']);
  const after = await runGit(repositoryPath, ['rev-parse', 'HEAD']);
  let downloadedVersion = null;
  try {
    downloadedVersion = readJson(path.join(repositoryPath, 'package.json')).version ?? null;
  } catch {
    // Version is optional in the update response.
  }
  return {
    ok: true,
    updated: before !== after,
    previous_commit: before.slice(0, 7),
    current_commit: after.slice(0, 7),
    downloaded_version: downloadedVersion,
    restart_required: before !== after,
  };
}

function sendError(response, error, status = 500) {
  console.error('[Shujuku Settings Vault]', error);
  response.status(status).json({ ok: false, error: error.message || '操作失败。' });
}

async function init(router) {
  router.get('/health', (request, response) => {
    try {
      response.json(getStatus(getUserPaths(request)));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/baseline', (request, response) => {
    try {
      const baseline = saveBaseline(getUserPaths(request));
      response.json({ ok: true, version: VERSION, created_at: baseline.created_at, target_hash: baseline.target_hash.slice(0, 12) });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/restore', (request, response) => {
    try {
      if (request.body?.confirm !== true) return response.status(400).json({ ok: false, error: '需要明确确认恢复操作。' });
      const result = restoreBaseline(getUserPaths(request));
      response.json({
        ok: true,
        target_hash: result.targetHash.slice(0, 12),
        full_backup: path.basename(result.fullBackupPath),
        changes: summarizeDiff(result.difference),
        reload_required: true,
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/rollback', (request, response) => {
    try {
      if (request.body?.confirm !== true) return response.status(400).json({ ok: false, error: '需要明确确认撤销操作。' });
      const result = rollbackRestore(getUserPaths(request));
      response.json({
        ok: true,
        target_hash: result.targetHash.slice(0, 12),
        full_backup: path.basename(result.fullBackupPath),
        changes: summarizeDiff(result.difference),
        reload_required: true,
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/report', (request, response) => {
    try {
      const paths = getUserPaths(request);
      const report = buildReport(paths);
      const savedReport = saveReport(paths, report);
      appendAudit(paths, {
        action: 'report_generated',
        current_hash: report.current.hash,
        changes: report.comparison?.summary ?? null,
        report_file: savedReport,
      });
      report.actions = readAudit(paths).slice(-50);
      response.json({ ok: true, report, saved_report: savedReport });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/update', async (_request, response) => {
    try {
      const result = await updateBackendPlugin();
      response.status(result.ok ? 200 : 409).json(result);
    } catch (error) {
      sendError(response, error);
    }
  });

  console.log(`[Shujuku Settings Vault] Server plugin v${VERSION} loaded.`);
}

async function exit() {
  return Promise.resolve();
}

module.exports = {
  init,
  exit,
  info: {
    id: PLUGIN_ID,
    name: 'Shujuku Settings Vault',
    description: 'Scoped backup, restore, rollback, and change reports for the Shujuku userscript settings block.',
  },
  _test: {
    TARGET_KEY,
    TARGET_PATH,
    appendAudit,
    buildReport,
    buildFriendlyChanges,
    buildFriendlySnapshot,
    cloneJson,
    diffValues,
    expandEmbeddedJson,
    getStatus,
    getValueAtPath,
    hashJson,
    hashWithoutTarget,
    patchSettingsTarget,
    pruneOwnedFiles,
    readBaseline,
    restoreBaseline,
    rollbackRestore,
    saveBaseline,
    saveReport,
    setValueAtPath,
    summarizeDiff,
  },
};
