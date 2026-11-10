import { collectBookmarks, sortResults } from './lib/bookmark-tree.js';

const el = (id) => document.getElementById(id);

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'broken', label: '失效' },
  { key: 'suspicious', label: '可疑' },
  { key: 'ok', label: '可用' },
  { key: 'skipped', label: '跳过' },
];

const state = {
  tree: [],
  selected: new Set(),
  results: [],
  filter: 'all',
  scanning: false,
  scanId: null,
  total: 0,
  done: 0,
  current: '',
  lastScan: null,
  backups: [],
};

let renderTimer = null;
let modalResolve = null;

init();

async function init() {
  bindEvents();
  if (!globalThis.chrome?.bookmarks) {
    showInfo('权限不足', '无法访问书签 API，请确认扩展已授予 bookmarks 权限。');
    return;
  }
  connectScanPort();
  await refreshTree();
  await loadSnapshot();
  await loadBackups();
}

function bindEvents() {
  el('scan-all').addEventListener('click', () => startScan('all'));
  el('scan-selected').addEventListener('click', () => startScan('selected'));
  el('select-all').addEventListener('click', () => {
    state.selected = new Set(['0']);
    renderTree();
  });
  el('select-none').addEventListener('click', () => {
    state.selected = new Set();
    renderTree();
  });
  el('cancel-scan').addEventListener('click', async () => {
    if (!state.scanId) return;
    await chrome.runtime.sendMessage({ type: 'CANCEL_SCAN', scanId: state.scanId });
  });
  el('cleanup').addEventListener('click', cleanupBroken);
  el('toggle-backups').addEventListener('click', () => {
    el('backup-list').classList.toggle('hidden');
  });
  el('modal-confirm').addEventListener('click', () => closeModal(true));
  el('modal-cancel').addEventListener('click', () => closeModal(false));
  document.querySelector('.modal-backdrop').addEventListener('click', () => closeModal(false));
}

function connectScanPort() {
  const port = chrome.runtime.connect({ name: 'scan' });
  port.onMessage.addListener((message) => {
    if (message.type === 'SNAPSHOT') {
      state.scanId = message.scanId ?? state.scanId;
      state.scanning = message.status === 'running';
      state.results = message.results ?? [];
      state.total = message.total ?? state.results.length;
      state.done = message.done ?? state.results.length;
      renderAll();
    } else if (message.type === 'PROGRESS') {
      state.done = message.done;
      state.total = message.total;
      state.current = message.current;
      updateProgress();
    } else if (message.type === 'ITEM_RESULT') {
      state.results.push(message.result);
      scheduleResultsRender();
    } else if (message.type === 'SCAN_DONE') {
      state.scanning = false;
      state.current = '';
      renderAll();
      void loadSnapshot();
      void loadBackups();
    }
  });
}

async function refreshTree() {
  state.tree = await chrome.bookmarks.getTree();
  renderTree();
}

async function loadSnapshot() {
  const data = await chrome.storage.local.get('lastScan');
  state.lastScan = data.lastScan ?? null;
  if (!state.lastScan) {
    renderAll();
    return;
  }
  // storage 里 status='running' 只代表上次未收尾，须靠 GET_SCAN_STATE 区分仍在扫描还是已被中断。
  const scanState = await chrome.runtime.sendMessage({ type: 'GET_SCAN_STATE' });
  const running = Boolean(scanState?.scanning);
  state.scanning = running;
  state.scanId = scanState?.scanId ?? state.lastScan.scanId ?? null;

  // SNAPSHOT 可能早于或晚于本函数到达；扫描进行中不得用 storage 旧快照覆盖实时结果。
  if (!running) {
    state.results = state.lastScan.results ?? [];
    state.total = state.lastScan.total ?? state.results.length;
    state.done = state.results.length;
  }
  renderAll();
  renderLastScanLabel(running);
}

async function loadBackups() {
  const response = await chrome.runtime.sendMessage({ type: 'LIST_BACKUPS' });
  state.backups = response?.backups ?? [];
  renderBackups();
}

function renderAll() {
  renderResults();
  updateProgress();
  updateScanButtons();
  updateSelectedCount();
}

function renderTree() {
  const host = el('bookmark-tree');
  host.textContent = '';
  const root = state.tree[0];
  const allSelected = state.selected.has('0');
  for (const node of root?.children ?? []) {
    host.append(renderFolderNode(node, allSelected));
  }
  updateSelectedCount();
}

function renderFolderNode(node, inheritedSelected) {
  const wrap = document.createElement('div');
  wrap.className = 'tree-node';

  const row = document.createElement('label');
  row.className = 'tree-row';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = inheritedSelected || state.selected.has(node.id);
  checkbox.indeterminate = !checkbox.checked && hasSelectedDescendant(node);
  checkbox.disabled = inheritedSelected;
  checkbox.addEventListener('change', () => toggleFolder(node, checkbox.checked));

  const name = document.createElement('span');
  name.textContent = node.title || '（未命名）';

  row.append(checkbox, name);
  wrap.append(row);

  for (const child of node.children ?? []) {
    if (child.url) {
      const leaf = document.createElement('div');
      leaf.className = 'tree-leaf';
      leaf.textContent = child.title || child.url;
      leaf.title = child.url;
      wrap.append(leaf);
    } else {
      wrap.append(renderFolderNode(child, checkbox.checked));
    }
  }
  return wrap;
}

function hasSelectedDescendant(node) {
  for (const child of node.children ?? []) {
    if (child.url) continue;
    if (state.selected.has(child.id) || hasSelectedDescendant(child)) return true;
  }
  return false;
}

function findFolderPath(id, node = state.tree[0], trail = []) {
  if (!node) return null;
  if (node.id === id) return trail;
  for (const child of node.children ?? []) {
    if (child.url) continue;
    const found = findFolderPath(id, child, [...trail, node]);
    if (found) return found;
  }
  return null;
}

function removeDescendantSelections(node) {
  for (const child of node.children ?? []) {
    if (child.url) continue;
    state.selected.delete(child.id);
    removeDescendantSelections(child);
  }
}

function toggleFolder(node, checked) {
  // '0' 是「全选」哨兵；展开成三个真实根后，勾选/取消才能按祖先与子树精确增减。
  if (state.selected.has('0')) {
    state.selected = new Set(['1', '2', '3']);
  }
  if (checked) {
    for (const ancestor of findFolderPath(node.id) ?? []) {
      state.selected.delete(ancestor.id);
    }
    state.selected.add(node.id);
  } else {
    state.selected.delete(node.id);
    removeDescendantSelections(node);
  }
  renderTree();
}

function updateSelectedCount() {
  const count = collectBookmarks(state.tree, [...state.selected]).length;
  el('selected-count').textContent = `已选 ${count} 个链接`;
}

async function startScan(mode) {
  if (state.scanning) return;
  const ids = mode === 'all' ? ['0'] : [...state.selected];
  const items = collectBookmarks(state.tree, ids);
  if (!items.length) {
    showInfo('无可扫描的书签', '请先勾选包含书签的文件夹。');
    return;
  }

  state.results = [];
  state.filter = 'all';
  state.scanning = true;
  state.done = 0;
  state.total = items.length;
  state.current = '';
  renderAll();

  try {
    const response = await chrome.runtime.sendMessage({ type: 'START_SCAN', items });
    if (response?.error) throw new Error(response.error);
    state.scanId = response.scanId;
  } catch (err) {
    state.scanning = false;
    renderAll();
    showInfo('扫描启动失败', escapeHtml(String(err?.message ?? err)));
  }
}

function updateScanButtons() {
  el('scan-all').disabled = state.scanning;
  el('scan-selected').disabled = state.scanning;
  el('cancel-scan').classList.toggle('hidden', !state.scanning);
}

function updateProgress() {
  const bar = el('progress');
  if (!state.scanning) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  const percent = state.total ? Math.round((state.done / state.total) * 100) : 0;
  el('progress-bar').style.width = `${percent}%`;
  el('progress-text').textContent = `已完成 ${state.done}/${state.total}${state.current ? ` · ${state.current}` : ''}`;
}

function scheduleResultsRender() {
  // ITEM_RESULT 逐条到达，100ms 合并一次渲染，避免每条都重建整份列表。
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    renderResults();
  }, 100);
}

function countOf(key) {
  return key === 'all'
    ? state.results.length
    : state.results.filter((result) => result.verdict === key).length;
}

function renderResults() {
  const host = el('results');
  host.textContent = '';

  const filtered = state.filter === 'all'
    ? state.results
    : state.results.filter((result) => result.verdict === state.filter);
  // 只在展示时排序，state.results 保持到达顺序，便于流式追加与按 bookmarkId 过滤。
  for (const result of sortResults(filtered)) {
    host.append(renderRow(result));
  }

  renderFilters();
  renderStats();

  const brokenCount = countOf('broken');
  const cleanupBtn = el('cleanup');
  cleanupBtn.textContent = `一键清理失效（${brokenCount}）`;
  cleanupBtn.disabled = brokenCount === 0 || state.scanning;

  const empty = el('empty');
  empty.classList.toggle('hidden', state.results.length > 0);
  if (!state.results.length) {
    empty.textContent = state.scanning ? '扫描进行中…' : '暂无结果，请选择范围后开始扫描。';
  }
}

function renderRow(result) {
  const row = document.createElement('div');
  row.className = `result-row verdict-${result.verdict}`;

  const main = document.createElement('div');
  main.className = 'result-main';

  const title = document.createElement('a');
  title.href = result.url;
  title.target = '_blank';
  title.rel = 'noreferrer';
  title.textContent = result.title || result.url;

  const url = document.createElement('span');
  url.className = 'result-url';
  url.textContent = result.finalUrl && result.finalUrl !== result.url
    ? `${result.url} → ${result.finalUrl}`
    : result.url;
  url.title = url.textContent;

  main.append(title, url);

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = verdictLabel(result);

  const del = document.createElement('button');
  del.className = 'btn small danger-ghost';
  del.textContent = '删除';
  del.addEventListener('click', () => confirmDelete(result));

  row.append(main, badge, del);
  return row;
}

function verdictLabel(result) {
  if (result.verdict === 'broken') {
    return `失效${result.error === 'timeout' ? ' · 超时' : result.error === 'network' ? ' · 网络错误' : ''}`;
  }
  if (result.verdict === 'suspicious') {
    return `可疑 · ${result.httpStatus ?? '未知'}`;
  }
  if (result.verdict === 'ok') {
    return `可用 · ${result.httpStatus ?? ''}`.trim();
  }
  return '跳过';
}

function renderFilters() {
  const host = el('filters');
  host.textContent = '';
  for (const filter of FILTERS) {
    const btn = document.createElement('button');
    btn.className = `filter${state.filter === filter.key ? ' active' : ''}`;
    btn.textContent = `${filter.label} ${countOf(filter.key)}`;
    btn.addEventListener('click', () => {
      state.filter = filter.key;
      renderResults();
    });
    host.append(btn);
  }
}

function renderStats() {
  const host = el('stats');
  host.textContent = '';
  const entries = [
    { key: 'ok', label: '可用', cls: 's-ok' },
    { key: 'broken', label: '失效', cls: 's-broken' },
    { key: 'suspicious', label: '可疑', cls: 's-suspicious' },
    { key: 'skipped', label: '跳过', cls: 's-skipped' },
  ];
  for (const entry of entries) {
    const span = document.createElement('span');
    span.className = entry.cls;
    const strong = document.createElement('strong');
    strong.textContent = String(countOf(entry.key));
    const label = document.createElement('span');
    label.className = 'stat-label';
    label.textContent = entry.label;
    span.append(strong, label);
    host.append(span);
  }
}

function renderLastScanLabel(running) {
  const label = el('last-scan');
  const last = state.lastScan;
  if (!last) {
    label.textContent = '';
    return;
  }
  const time = formatTime(last.finishedAt ?? last.startedAt);
  if (running) {
    label.textContent = `扫描进行中 · 共 ${last.total} 个链接 · 开始于 ${formatTime(last.startedAt)}`;
    return;
  }
  if (last.status === 'running') {
    label.textContent = `上次扫描中断于 ${time}，已完成 ${last.results?.length ?? 0}/${last.total} 条`;
    return;
  }
  label.textContent = `上次扫描：${time} · ${last.results?.length ?? 0} 条${last.status === 'cancelled' ? '（已取消）' : ''}`;
}

async function confirmDelete(result) {
  const ok = await openModal({
    title: '删除书签',
    body: `确定删除「${escapeHtml(result.title || result.url)}」？<br><span class="muted">${escapeHtml(result.url)}</span><br><br>此操作不可撤销。`,
    confirmText: '删除',
    showCancel: true,
  });
  if (!ok) return;

  const response = await chrome.runtime.sendMessage({
    type: 'DELETE_BOOKMARKS',
    bookmarkIds: [result.bookmarkId],
  });
  if (response?.error) {
    showInfo('删除失败', escapeHtml(response.error));
    return;
  }
  if (response.removed?.length) {
    state.results = state.results.filter((entry) => entry.bookmarkId !== result.bookmarkId);
    renderAll();
    await refreshTree();
  } else {
    showInfo('删除失败', escapeHtml(response.failed?.[0]?.error ?? '未知错误'));
  }
}

async function cleanupBroken() {
  const broken = state.results.filter((result) => result.verdict === 'broken');
  if (!broken.length) return;

  const ok = await openModal({
    title: '一键清理失效书签',
    body: `将删除 <strong>${broken.length}</strong> 个确认失效的书签。<br>删除前会自动生成备份并下载备份文件，备份同时保存在「备份记录」中。<br><br>此操作不可撤销。`,
    confirmText: '备份并清理',
    showCancel: true,
  });
  if (!ok) return;

  const backupItems = broken.map((result) => ({
    title: result.title,
    url: result.url,
    rootKind: result.rootKind,
    path: result.folderPath,
  }));

  let backup;
  try {
    // 删除不可撤销：备份失败即中止，且先下载备份文件，再调用 DELETE_BOOKMARKS。
    const response = await chrome.runtime.sendMessage({ type: 'CREATE_BACKUP', items: backupItems });
    if (response?.error) throw new Error(response.error);
    backup = response.backup;
  } catch (err) {
    showInfo('备份失败，已中止清理', escapeHtml(String(err?.message ?? err)));
    return;
  }

  downloadBackup(backup);

  const response = await chrome.runtime.sendMessage({
    type: 'DELETE_BOOKMARKS',
    bookmarkIds: broken.map((result) => result.bookmarkId),
  });
  if (response?.error) {
    showInfo('清理失败', escapeHtml(response.error));
    return;
  }

  const removedSet = new Set(response.removed ?? []);
  state.results = state.results.filter((result) => !removedSet.has(result.bookmarkId));
  renderAll();
  await refreshTree();
  await loadBackups();

  const failedCount = response.failed?.length ?? 0;
  showInfo(
    '清理完成',
    `已删除 ${response.removed?.length ?? 0} 条失效书签${failedCount ? `，失败 ${failedCount} 条` : ''}。<br>备份文件已下载，可在「备份记录」中恢复。`,
  );
}

function downloadBackup(backup) {
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `bookmark-checker-backup-${backup.id}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function renderBackups() {
  const host = el('backup-list');
  host.textContent = '';
  if (!state.backups.length) {
    host.textContent = '暂无备份';
    return;
  }
  for (const backup of state.backups) {
    const row = document.createElement('div');
    row.className = 'backup-row';

    const info = document.createElement('span');
    info.textContent = `${formatTime(backup.createdAt)} · ${backup.count} 条`;

    const download = document.createElement('button');
    download.className = 'link-btn';
    download.textContent = '下载';
    download.addEventListener('click', async () => {
      const response = await chrome.runtime.sendMessage({ type: 'GET_BACKUP', id: backup.id });
      if (response?.backup) downloadBackup(response.backup);
    });

    const restore = document.createElement('button');
    restore.className = 'link-btn';
    restore.textContent = '恢复';
    restore.addEventListener('click', () => restoreBackup(backup));

    row.append(info, download, restore);
    host.append(row);
  }
}

async function restoreBackup(summary) {
  const ok = await openModal({
    title: '从备份恢复',
    body: `将把备份中的 <strong>${summary.count}</strong> 个书签恢复到原文件夹（同名文件夹不存在时自动创建）。`,
    confirmText: '恢复',
    showCancel: true,
  });
  if (!ok) return;

  const full = await chrome.runtime.sendMessage({ type: 'GET_BACKUP', id: summary.id });
  if (!full?.backup) {
    showInfo('恢复失败', '备份不存在。');
    return;
  }

  const response = await chrome.runtime.sendMessage({ type: 'RESTORE_BACKUP', backup: full.backup });
  if (response?.error) {
    showInfo('恢复失败', escapeHtml(response.error));
    return;
  }
  await refreshTree();
  const failedCount = response.failed?.length ?? 0;
  showInfo(
    '恢复完成',
    `已恢复 ${response.created ?? 0} 条书签${failedCount ? `，失败 ${failedCount} 条` : ''}。`,
  );
}

function openModal({ title, body, confirmText = '确认', showCancel = true }) {
  el('modal-title').textContent = title;
  // body 是静态 HTML 片段，拼接进去的书签标题/URL 必须先 escapeHtml，防止脚本注入。
  el('modal-body').innerHTML = body;
  el('modal-confirm').textContent = confirmText;
  el('modal-cancel').classList.toggle('hidden', !showCancel);
  el('modal-root').classList.remove('hidden');
  return new Promise((resolve) => {
    modalResolve = resolve;
  });
}

function showInfo(title, body) {
  return openModal({ title, body, confirmText: '关闭', showCancel: false });
}

function closeModal(value) {
  el('modal-root').classList.add('hidden');
  const resolve = modalResolve;
  modalResolve = null;
  resolve?.(value);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatTime(timestamp) {
  if (!timestamp) return '未知时间';
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
}
