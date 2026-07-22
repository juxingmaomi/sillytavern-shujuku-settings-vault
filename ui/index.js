(() => {
  'use strict';

  const MODULE_NAME = 'shujuku_settings_vault';
  const DISPLAY_NAME = '数据库配置保险箱';
  const VERSION = '0.2.0';
  const EXTENSION_FOLDER = 'shujuku-settings-vault';
  const API_ROOT = '/api/plugins/shujuku-settings-vault';
  const PANEL_ID = 'shujuku-settings-vault-panel';

  const state = {
    context: null,
    status: null,
    report: null,
    busy: false,
  };

  function getContext() {
    return globalThis.SillyTavern?.getContext?.() ?? null;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function formatDate(value) {
    if (!value) return '尚未记录';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(date);
  }

  function toast(type, message, title = DISPLAY_NAME) {
    const handler = globalThis.toastr?.[type];
    if (typeof handler === 'function') handler(message, title, { timeOut: type === 'error' ? 7000 : 4500 });
  }

  async function confirmAction(title, message) {
    const context = state.context ?? getContext();
    if (context?.Popup?.show?.confirm) return Boolean(await context.Popup.show.confirm(title, message));
    return globalThis.confirm(`${title}\n\n${message.replace(/<[^>]+>/g, '')}`);
  }

  async function requestApi(route, options = {}) {
    const context = state.context ?? getContext();
    if (!context) throw new Error('酒馆上下文尚未准备好。');
    const method = options.method ?? 'GET';
    const request = {
      method,
      headers: context.getRequestHeaders(),
      cache: 'no-store',
    };
    if (options.body !== undefined) request.body = JSON.stringify(options.body);
    const response = await fetch(`${API_ROOT}/${route}`, request);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
    return data;
  }

  function panelHtml() {
    return `
      <section id="${PANEL_ID}" class="svault-panel" aria-label="${DISPLAY_NAME}">
        <details class="svault-shell" open>
          <summary class="svault-heading" title="点击展开或收起数据库配置保险箱">
            <div class="svault-heading-main">
              <i class="fa-solid fa-circle-chevron-down svault-collapse-icon" aria-hidden="true"></i>
              <div class="svault-title-line">
                <i class="fa-solid fa-shield-halved" aria-hidden="true"></i>
                <strong>${DISPLAY_NAME}</strong>
                <span class="svault-version" title="前端版本">v${VERSION}</span>
              </div>
            </div>
            <span class="svault-health" data-role="health"><i class="fa-solid fa-circle-notch fa-spin"></i> 正在连接后端</span>
          </summary>

          <div class="svault-body">

          <div class="svault-status-grid" aria-live="polite">
          <div><span>基准配置</span><strong data-role="baseline-time">读取中</strong></div>
          <div><span>当前状态</span><strong data-role="match-state">读取中</strong></div>
          <div><span>服务器写入</span><strong data-role="settings-time">读取中</strong></div>
          <div><span>后端版本</span><strong data-role="backend-version">读取中</strong></div>
          </div>

          <div class="svault-actions svault-actions-primary">
          <button type="button" class="menu_button svault-button" data-action="baseline" title="保存 API、向量、剧情和提取规则等关键配置">
            <i class="fa-solid fa-floppy-disk"></i><span>保存关键配置</span>
          </button>
          <button type="button" class="menu_button svault-button svault-button-accent" data-action="restore" title="只恢复关键配置，不覆盖角色、聊天和表格数据">
            <i class="fa-solid fa-clock-rotate-left"></i><span>恢复关键配置</span>
          </button>
          <button type="button" class="menu_button svault-button" data-action="rollback" title="撤销最近一次恢复">
            <i class="fa-solid fa-rotate-left"></i><span>撤销恢复</span>
          </button>
          </div>

          <div class="svault-actions svault-actions-secondary">
          <button type="button" class="menu_button svault-button" data-action="report" title="比较当前配置、基准配置和最近设置备份">
            <i class="fa-solid fa-list-check"></i><span>检查变化</span>
          </button>
          <button type="button" class="menu_button svault-button" data-action="export" title="导出已遮蔽敏感内容的 JSON 报告" disabled>
            <i class="fa-solid fa-file-arrow-down"></i><span>导出报告</span>
          </button>
          <button type="button" class="menu_button svault-button" data-action="update" title="手动检查并下载前端与后端更新">
            <i class="fa-solid fa-arrows-rotate"></i><span>手动更新</span>
          </button>
          </div>

          <div class="svault-notice">
          <i class="fa-solid fa-circle-info" aria-hidden="true"></i>
          <span>恢复只处理关键数据库配置，角色独立设置、聊天分支和表格实际数据会保留。操作前请关闭其他设备上的酒馆页面。</span>
          </div>

          <details class="svault-report" data-role="report-box">
            <summary><i class="fa-solid fa-chart-column"></i> 变更报告</summary>
            <div class="svault-report-content" data-role="report-content">点击“检查变化”后显示。</div>
          </details>
          </div>
        </details>
      </section>`;
  }

  function setText(role, text, className = '') {
    const element = document.querySelector(`#${PANEL_ID} [data-role="${role}"]`);
    if (!element) return;
    element.textContent = text;
    element.className = className;
  }

  function renderStatus() {
    const status = state.status;
    if (!status) return;
    const health = document.querySelector(`#${PANEL_ID} [data-role="health"]`);
    if (health) {
      health.className = 'svault-health is-ok';
      health.innerHTML = '<i class="fa-solid fa-circle-check"></i> 后端已连接';
    }
    setText('baseline-time', status.baseline_exists ? formatDate(status.baseline_created_at) : '尚未保存');
    setText(
      'match-state',
      status.current_matches_baseline === null ? '没有基准' : status.current_matches_baseline ? '与基准一致' : '检测到变化',
      status.current_matches_baseline === false ? 'is-warning' : status.current_matches_baseline === true ? 'is-ok' : '',
    );
    setText('settings-time', formatDate(status.current_settings_modified_at));
    setText('backend-version', `v${status.version}`);
    const rollback = document.querySelector(`#${PANEL_ID} [data-action="rollback"]`);
    if (rollback) rollback.disabled = !status.rollback_available || state.busy;
  }

  function renderUnavailable(error) {
    const health = document.querySelector(`#${PANEL_ID} [data-role="health"]`);
    if (health) {
      health.className = 'svault-health is-error';
      health.innerHTML = '<i class="fa-solid fa-circle-xmark"></i> 后端不可用';
      health.title = error.message;
    }
    setText('baseline-time', '无法读取');
    setText('match-state', '请检查后端插件', 'is-error');
    setText('settings-time', '无法读取');
    setText('backend-version', '未连接');
  }

  function setBusy(busy, activeButton = null) {
    state.busy = busy;
    document.querySelectorAll(`#${PANEL_ID} button`).forEach(button => {
      button.disabled = busy || (button.dataset.action === 'export' && !state.report);
    });
    if (!busy && state.status) renderStatus();
    if (activeButton) {
      const icon = activeButton.querySelector('i');
      icon?.classList.toggle('fa-spin', busy);
    }
  }

  async function refreshStatus(options = {}) {
    try {
      state.status = await requestApi('health');
      renderStatus();
      if (options.toast) toast('success', '服务器数据库配置状态已刷新。');
      return state.status;
    } catch (error) {
      renderUnavailable(error);
      if (options.toast) toast('error', error.message);
      throw error;
    }
  }

  function kindLabel(kind) {
    return ({ added: '新增', removed: '移除', changed: '修改' })[kind] ?? kind;
  }

  function reportDetailsHtml(details) {
    if (!details?.length) return '<p class="svault-empty">没有发现字段变化。</p>';
    return `
      <div class="svault-diff-list">
        ${details.map(item => `
          <div class="svault-diff-row">
            <code>${escapeHtml(item.path)}</code>
            <span class="svault-diff-kind is-${escapeHtml(item.kind)}">${kindLabel(item.kind)}</span>
            <div><small>之前</small><span>${escapeHtml(item.before)}</span></div>
            <div><small>现在</small><span>${escapeHtml(item.after)}</span></div>
          </div>`).join('')}
      </div>`;
  }

  function renderReport() {
    const report = state.report;
    const container = document.querySelector(`#${PANEL_ID} [data-role="report-content"]`);
    const box = document.querySelector(`#${PANEL_ID} [data-role="report-box"]`);
    if (!container || !report) return;
    const comparison = report.comparison;
    const summary = comparison?.summary;
    const friendly = comparison?.friendly;
    const timeline = report.timeline ?? [];
    container.innerHTML = `
      <div class="svault-report-summary">
        <span>生成时间：${escapeHtml(formatDate(report.generated_at))}</span>
        <span>当前指纹：${escapeHtml(report.current.hash)}</span>
        <span>${report.baseline ? `基准指纹：${escapeHtml(report.baseline.hash)}` : '尚未保存基准'}</span>
      </div>
      <h4>检查结果</h4>
      ${friendly
        ? `<div class="svault-result ${friendly.important_count ? 'is-warning' : friendly.changes.length ? 'is-notice' : 'is-ok'}">
            <strong>${friendly.important_count ? `发现 ${friendly.important_count} 项重要变化` : friendly.changes.length ? `发现 ${friendly.normal_count} 项普通变化` : '主要设置与基准一致'}</strong>
            <span>${escapeHtml(friendly.recommendation)}</span>
          </div>`
        : '<p class="svault-empty">保存基准配置后才能进行完整比较。</p>'}
      ${friendly?.changes?.length
        ? `<div class="svault-friendly-list">${friendly.changes.map(item => `
            <div class="svault-friendly-row ${item.level === 'important' ? 'is-important' : ''}">
              <div><span>${escapeHtml(item.category)}</span><strong>${escapeHtml(item.title)}</strong></div>
              <p><small>原来</small>${escapeHtml(item.before)}</p>
              <i class="fa-solid fa-arrow-right" aria-hidden="true"></i>
              <p><small>现在</small>${escapeHtml(item.after)}</p>
              <em>${escapeHtml(item.impact)}</em>
            </div>`).join('')}</div>`
        : ''}
      <h4>最近设置备份中的状态切换</h4>
      ${timeline.length
        ? `<div class="svault-timeline">${timeline.map(item => `
            <div>
              <time>${escapeHtml(formatDate(item.detected_at))}</time>
              <span>${escapeHtml(item.from_hash)} → ${escapeHtml(item.to_hash)}</span>
              <small>${item.changes.total} 项字段变化</small>
            </div>`).join('')}</div>`
        : '<p class="svault-empty">最近的酒馆设置备份中没有发现状态切换。</p>'}
      ${summary ? `<details class="svault-technical"><summary>技术细节（共 ${summary.total} 个字段变化）</summary>${reportDetailsHtml(comparison.details)}</details>` : ''}
      <p class="svault-report-note">报告按现有备份判断变化，不能精确识别是哪台设备或哪一秒执行了保存。</p>`;
    box.open = true;
    const exportButton = document.querySelector(`#${PANEL_ID} [data-action="export"]`);
    if (exportButton) exportButton.disabled = false;
  }

  function exportReport() {
    if (!state.report) {
      toast('error', '请先点击“检查变化”。');
      return;
    }
    const content = JSON.stringify(state.report, null, 2);
    const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `数据库配置变更报告-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast('success', '变更报告已导出。');
  }

  async function saveBaseline(button) {
    const confirmed = await confirmAction(
      '保存关键配置基准',
      '将保存 API、向量、重排、剧情召回、正文提取和表格注入规则。<br><br>不会把聊天记录、角色独立设置或表格实际数据保存为恢复内容。',
    );
    if (!confirmed) return;
    setBusy(true, button);
    try {
      const result = await requestApi('baseline', { method: 'POST', body: {} });
      toast('success', `基准配置已保存。指纹：${result.target_hash}`);
      state.report = null;
      await refreshStatus();
    } catch (error) {
      toast('error', `保存失败：${error.message}`);
    } finally {
      setBusy(false, button);
    }
  }

  async function restoreBaseline(button) {
    const confirmed = await confirmAction(
      '恢复关键数据库配置',
      '<strong>请先关闭手机和其他电脑上的酒馆页面。</strong><br><br>只恢复 API、向量、剧情召回、正文提取和表格注入规则。不会覆盖角色独立设置、聊天分支或表格实际数据；恢复前仍会完整备份当前 settings.json。',
    );
    if (!confirmed) return;
    setBusy(true, button);
    try {
      const result = await requestApi('restore', { method: 'POST', body: { confirm: true } });
      toast('success', `关键数据库配置已恢复，共处理 ${result.changes.total} 项变化。角色和聊天数据未覆盖，请重新加载页面。`);
      state.report = null;
      await refreshStatus();
    } catch (error) {
      toast('error', `恢复失败：${error.message}`);
    } finally {
      setBusy(false, button);
    }
  }

  async function rollbackRestore(button) {
    const confirmed = await confirmAction(
      '撤销最近一次恢复',
      '将只撤销上一次“恢复关键配置”操作。角色、聊天和表格数据不会被覆盖。操作前仍会再次备份当前 settings.json。',
    );
    if (!confirmed) return;
    setBusy(true, button);
    try {
      const result = await requestApi('rollback', { method: 'POST', body: { confirm: true } });
      toast('success', `已撤销最近一次恢复，共处理 ${result.changes.total} 项变化。请重新加载页面。`);
      state.report = null;
      await refreshStatus();
    } catch (error) {
      toast('error', `撤销失败：${error.message}`);
    } finally {
      setBusy(false, button);
    }
  }

  async function loadReport(button) {
    setBusy(true, button);
    try {
      const result = await requestApi('report', { method: 'POST', body: {} });
      state.report = result.report;
      renderReport();
      toast('success', '变更报告已生成。');
    } catch (error) {
      toast('error', `报告生成失败：${error.message}`);
    } finally {
      setBusy(false, button);
    }
  }

  async function getExtensionInstallInfo() {
    const response = await fetch('/api/extensions/discover', { cache: 'no-store' });
    if (!response.ok) throw new Error('无法读取酒馆扩展列表。');
    const extensions = await response.json();
    const item = extensions.find(extension => extension.name === `third-party/${EXTENSION_FOLDER}`);
    return item ?? { type: 'local', name: `third-party/${EXTENSION_FOLDER}` };
  }

  async function updateFrontend() {
    const context = state.context ?? getContext();
    const installInfo = await getExtensionInstallInfo();
    const response = await fetch('/api/extensions/update', {
      method: 'POST',
      headers: context.getRequestHeaders(),
      body: JSON.stringify({
        extensionName: EXTENSION_FOLDER,
        global: installInfo.type === 'global',
      }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(text || `前端更新失败（${response.status}）`);
    const data = JSON.parse(text);
    return {
      updated: !data.isUpToDate,
      commit: data.shortCommitHash,
    };
  }

  async function updatePlugin(button) {
    setBusy(true, button);
    try {
      const results = await Promise.allSettled([
        updateFrontend(),
        requestApi('update', { method: 'POST', body: {} }),
      ]);
      const frontend = results[0];
      const backend = results[1];
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason.message);
      if (errors.length) throw new Error(errors.join('；'));

      const frontendUpdated = frontend.value.updated;
      const backendUpdated = backend.value.updated;
      if (!frontendUpdated && !backendUpdated) {
        toast('success', '前端和后端都已经是最新版本。');
      } else {
        const parts = [];
        if (frontendUpdated) parts.push(`前端已更新到 ${frontend.value.commit}`);
        if (backendUpdated) parts.push(`后端文件已更新到 ${backend.value.current_commit}`);
        const suffix = backend.value.restart_required ? '后端更新会在下次正常重启酒馆时生效，本插件不会自动重启。' : '刷新页面后应用前端更新。';
        toast('success', `${parts.join('；')}。${suffix}`);
      }
    } catch (error) {
      toast('error', `更新失败：${error.message}`);
    } finally {
      setBusy(false, button);
    }
  }

  function bindEvents(panel) {
    panel.addEventListener('click', event => {
      const button = event.target.closest('button[data-action]');
      if (!button || state.busy) return;
      const actions = {
        baseline: saveBaseline,
        restore: restoreBaseline,
        rollback: rollbackRestore,
        report: loadReport,
        export: () => exportReport(),
        update: updatePlugin,
      };
      void actions[button.dataset.action]?.(button);
    });
  }

  async function mountPanel() {
    if (document.getElementById(PANEL_ID)) return true;
    const container = document.querySelector('#extensions_settings2')
      ?? document.querySelector('#extensions_settings')
      ?? document.querySelector('.extensions_settings');
    if (!container) return false;
    container.insertAdjacentHTML('beforeend', panelHtml());
    const panel = document.getElementById(PANEL_ID);
    bindEvents(panel);
    try {
      await refreshStatus();
    } catch (error) {
      console.warn(`[${MODULE_NAME}] Backend unavailable`, error);
    }
    return true;
  }

  async function init() {
    state.context = getContext();
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (await mountPanel()) return;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    console.error(`[${MODULE_NAME}] Could not find the SillyTavern extension settings container.`);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void init(), { once: true });
  } else {
    void init();
  }
})();
