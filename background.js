import { runScan } from './lib/scanner.js';
import { buildBackup, trimBackups, buildRestorePlan, MAX_BACKUPS } from './lib/backup.js';

const SNAPSHOT_KEY = 'lastScan';
const BACKUPS_KEY = 'backups';
const KEEPALIVE_MS = 25000;
const SNAPSHOT_EVERY = 50;

let activeScan = null;
// 多个页面可能同时连入，故用集合而非单槽位广播。
const scanPorts = new Set();

function broadcast(message) {
  // 页面关闭后端口失效，postMessage 会抛错；逐端口捕获并剔除，不影响其他页面。
  for (const port of [...scanPorts]) {
    try {
      port.postMessage(message);
    } catch {
      scanPorts.delete(port);
    }
  }
}

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('app.html') });
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'scan') return;
  scanPorts.add(port);
  port.onDisconnect.addListener(() => {
    scanPorts.delete(port);
  });
  if (activeScan) {
    // 扫描中重开页面时内存结果领先于 storage 快照，故仅向新端口补发当前状态。
    try {
      port.postMessage({
        type: 'SNAPSHOT',
        scanId: activeScan.scanId,
        results: activeScan.results.slice(),
        done: activeScan.results.length,
        total: activeScan.total,
        status: 'running',
      });
    } catch {
      scanPorts.delete(port);
    }
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

  // 快照写入失败只告警，不能阻断扫描启动
  await writeSnapshot('running', null).catch((err) => {
    console.warn('初始扫描快照写入失败:', err);
  });

  // 已连接的页面不会收到后续新开端口才有的快照，故主动广播开局状态，避免新旧结果混杂。
  broadcast({
    type: 'SNAPSHOT',
    scanId,
    results: [],
    done: 0,
    total: items.length,
    status: 'running',
  });

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
      if (state.results.length % SNAPSHOT_EVERY === 0) {
        void writeSnapshot('running', null).catch((err) => {
          console.warn('扫描快照写入失败:', err);
        });
      }
    },
  })
    .then(async () => {
      const status = controller.signal.aborted ? 'cancelled' : 'done';
      const finishedAt = Date.now();
      try {
        await writeSnapshot(status, finishedAt);
      } catch (err) {
        console.warn('扫描结果快照写入失败:', err);
      }
      broadcast({ type: 'SCAN_DONE', status, finishedAt });
    })
    .catch(async (err) => {
      console.error('扫描异常:', err);
      const finishedAt = Date.now();
      try {
        await writeSnapshot('cancelled', finishedAt);
      } catch (writeErr) {
        console.warn('扫描结果快照写入失败:', writeErr);
      }
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

async function bookmarkExists(id) {
  try {
    const nodes = await chrome.bookmarks.get(id);
    return nodes.length > 0;
  } catch {
    return false;
  }
}

async function deleteBookmarks(bookmarkIds) {
  const removed = [];
  const failed = [];

  for (const id of bookmarkIds) {
    try {
      try {
        await chrome.bookmarks.remove(id);
      } catch (err) {
        // 用 get 复核是否已不存在，避免依赖会被本地化的错误文案
        if (await bookmarkExists(id)) throw err;
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
    try {
      await chrome.storage.local.set({ [SNAPSHOT_KEY]: snapshot });
    } catch (err) {
      // 删除已经生效，快照回写失败不应让 UI 误报「清理失败」。
      console.warn('删除后的扫描快照写入失败:', err);
    }
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
