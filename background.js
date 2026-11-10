import { runScan } from './lib/scanner.js';
import { buildBackup, trimBackups, buildRestorePlan, MAX_BACKUPS } from './lib/backup.js';

const SNAPSHOT_KEY = 'lastScan';
const BACKUPS_KEY = 'backups';
const KEEPALIVE_MS = 25000;
const SNAPSHOT_EVERY = 50;

let activeScan = null;
let scanPort = null;

function broadcast(message) {
  // 页面关闭后端口失效，postMessage 会抛错；捕获并置空，后续广播直接跳过。
  if (!scanPort) return;
  try {
    scanPort.postMessage(message);
  } catch {
    scanPort = null;
  }
}

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('app.html') });
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'scan') return;
  scanPort = port;
  port.onDisconnect.addListener(() => {
    if (scanPort === port) scanPort = null;
  });
  if (activeScan) {
    // 扫描中重开页面时内存结果领先于 storage 快照，故连接即重发当前状态。
    broadcast({
      type: 'SNAPSHOT',
      scanId: activeScan.scanId,
      results: activeScan.results.slice(),
      done: activeScan.results.length,
      total: activeScan.total,
      status: 'running',
    });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ error: String(err?.message ?? err) }));
  return true;
});

async function handleMessage(message) {
  switch (message?.type) {
    case 'START_SCAN':
      return startScan(message.items);
    case 'GET_SCAN_STATE':
      return { scanning: Boolean(activeScan), scanId: activeScan?.scanId ?? null };
    case 'CANCEL_SCAN':
      return cancelScan(message.scanId);
    // 清理由 UI 编排：先 CREATE_BACKUP 写备份成功，再 DELETE_BOOKMARKS 删除。
    case 'DELETE_BOOKMARKS':
      return deleteBookmarks(message.bookmarkIds);
    case 'CREATE_BACKUP':
      return createBackup(message.items);
    case 'LIST_BACKUPS':
      return listBackups();
    case 'GET_BACKUP':
      return getBackup(message.id);
    case 'RESTORE_BACKUP':
      return restoreBackup(message.backup);
    default:
      throw new Error(`未知消息类型: ${message?.type}`);
  }
}

async function startScan(items) {
  if (activeScan) throw new Error('已有扫描进行中');
  if (!Array.isArray(items) || items.length === 0) throw new Error('没有可扫描的书签');

  const scanId = `scan_${Date.now()}`;
  const startedAt = Date.now();
  const controller = new AbortController();
  const state = { scanId, controller, results: [], total: items.length };
  activeScan = state;

  // MV3 后台空闲约 30 秒即被终止，定期调用平台 API 保活以免长扫描被中途掐断。
  const keepAlive = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {});
  }, KEEPALIVE_MS);

  const writeSnapshot = async (status, finishedAt) => {
    await chrome.storage.local.set({
      [SNAPSHOT_KEY]: {
        scanId,
        startedAt,
        finishedAt,
        status,
        total: items.length,
        results: state.results.slice(),
      },
    });
  };

  await writeSnapshot('running', null);

  runScan({
    items,
    signal: controller.signal,
    onResult: (result) => {
      state.results.push(result);
      broadcast({ type: 'ITEM_RESULT', result });
      broadcast({
        type: 'PROGRESS',
        done: state.results.length,
        total: state.total,
        current: result.url,
      });
      // 逐条写 storage 太贵，每 50 条落一次盘兼顾崩溃恢复与写入开销。
      if (state.results.length % SNAPSHOT_EVERY === 0) void writeSnapshot('running', null);
    },
  })
    .then(async () => {
      const status = controller.signal.aborted ? 'cancelled' : 'done';
      const finishedAt = Date.now();
      await writeSnapshot(status, finishedAt);
      broadcast({ type: 'SCAN_DONE', status, finishedAt });
    })
    .catch(async (err) => {
      console.error('扫描异常:', err);
      const finishedAt = Date.now();
      await writeSnapshot('cancelled', finishedAt);
      broadcast({ type: 'SCAN_DONE', status: 'cancelled', finishedAt });
    })
    .finally(() => {
      clearInterval(keepAlive);
      activeScan = null;
    });

  return { scanId };
}

function cancelScan(scanId) {
  if (!activeScan || activeScan.scanId !== scanId) return { cancelled: false };
  activeScan.controller.abort();
  return { cancelled: true };
}

async function deleteBookmarks(bookmarkIds) {
  const removed = [];
  const failed = [];

  for (const id of bookmarkIds) {
    try {
      try {
        await chrome.bookmarks.remove(id);
      } catch (err) {
        // 书签已被用户或同步删除时目标已达成，按成功计，避免误报失败。
        if (!/find bookmark/i.test(String(err?.message ?? err))) throw err;
      }
      removed.push(id);
    } catch (err) {
      failed.push({ id, error: String(err?.message ?? err) });
    }
  }

  const removedSet = new Set(removed);
  if (activeScan) {
    activeScan.results = activeScan.results.filter((result) => !removedSet.has(result.bookmarkId));
  }

  const stored = await chrome.storage.local.get(SNAPSHOT_KEY);
  const snapshot = stored[SNAPSHOT_KEY];
  if (snapshot && removed.length) {
    snapshot.results = snapshot.results.filter((result) => !removedSet.has(result.bookmarkId));
    await chrome.storage.local.set({ [SNAPSHOT_KEY]: snapshot });
  }

  return { removed, failed };
}

async function createBackup(items) {
  const now = Date.now();
  const backup = buildBackup(items, {
    id: `bk_${now}_${Math.random().toString(36).slice(2, 8)}`,
    now,
  });
  const stored = await chrome.storage.local.get(BACKUPS_KEY);
  const backups = trimBackups([backup, ...(stored[BACKUPS_KEY] ?? [])], MAX_BACKUPS);
  await chrome.storage.local.set({ [BACKUPS_KEY]: backups });
  return { backup };
}

async function listBackups() {
  const stored = await chrome.storage.local.get(BACKUPS_KEY);
  const backups = (stored[BACKUPS_KEY] ?? []).map(({ id, createdAt, count, reason }) => ({
    id,
    createdAt,
    count,
    reason,
  }));
  return { backups };
}

async function getBackup(id) {
  const stored = await chrome.storage.local.get(BACKUPS_KEY);
  const backup = (stored[BACKUPS_KEY] ?? []).find((entry) => entry.id === id) ?? null;
  return { backup };
}

async function restoreBackup(backup) {
  if (!backup || !Array.isArray(backup.items)) throw new Error('备份数据无效');

  const tree = await chrome.bookmarks.getTree();
  const plan = buildRestorePlan(backup, tree);
  // 同路径的多个书签会反复申请建同一文件夹，缓存 parentId+标题复用首次创建的 ID。
  const folderCache = new Map();
  let created = 0;
  const failed = [];

  for (const entry of plan) {
    if (entry.missingRoot) {
      failed.push({ title: entry.item.title, error: '目标根目录不存在' });
      continue;
    }
    try {
      let parentId = entry.rootId;
      for (const folder of entry.folders) {
        const cacheKey = `${parentId}\u0000${folder.title}`;
        let folderId = folder.existingId ?? folderCache.get(cacheKey) ?? null;
        if (!folderId) {
          const node = await chrome.bookmarks.create({ parentId, title: folder.title });
          folderId = node.id;
        }
        folderCache.set(cacheKey, folderId);
        parentId = folderId;
      }
      await chrome.bookmarks.create({
        parentId,
        title: entry.item.title,
        url: entry.item.url,
      });
      created += 1;
    } catch (err) {
      failed.push({ title: entry.item.title, error: String(err?.message ?? err) });
    }
  }

  return { created, failed };
}
