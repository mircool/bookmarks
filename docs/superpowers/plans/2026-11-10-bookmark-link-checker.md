# 书签失效检测器 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个 Chrome MV3 扩展，批量检测书签可达性，按可用/失效/可疑/跳过分类，支持单项删除、自动备份的一键清理与备份恢复。

**Architecture:** 原生 ES Modules，零第三方依赖。全页 UI（`app.html`）负责书签树、结果展示与操作；service worker（`background.js`）负责扫描调度、书签删除、备份存取；纯逻辑拆为 `lib/` 下三个可单测模块（判定、扫描、备份、树遍历），由 `node:test` 覆盖。

**Tech Stack:** JavaScript (ES2022)、Chrome Manifest V3、`chrome.bookmarks` / `chrome.storage` / `chrome.runtime`、Node.js 24 `node:test`、原生 HTML/CSS。

**Spec:** [docs/superpowers/specs/2026-11-10-bookmark-link-checker-design.md](../specs/2026-11-10-bookmark-link-checker-design.md)

## Global Constraints

- 平台：Chrome ≥ 116（依赖 `AbortSignal.any`）；Manifest V3。
- 依赖：零第三方运行时依赖；测试仅用 Node 内置 `node:test` 与 `node:assert`。
- 权限仅：`bookmarks`、`storage`、`host_permissions: ["http://*/*", "https://*/*"]`；不申请 `downloads`、`tabs` 之外的权限。打开新标签页用 `chrome.tabs.create`，无需 `tabs` 权限。
- 判定尺度：网络错误/超时/404/410/5xx → `broken`；401/403/407/429/其余 4xx → `suspicious`；2xx/3xx → `ok`；非 `http(s)` → `skipped`。
- 探测：先 HEAD（跟随重定向，单请求 15s 超时）；HEAD 超时直接 `broken` 且不复核；HEAD 网络错误或非 2xx/3xx 用 GET 复核；GET 取到响应头后立即取消响应体。
- 扫描并发上限 8；同 URL 单次扫描内只请求一次。
- 一键清理只处理 `broken`；备份先写入 `storage.local` 成功后才允许删除；备份最多保留 10 份。
- 文案全中文；确认/提示一律用页内自定义弹窗，禁止 `confirm`/`alert`。
- 提交策略：执行本计划前须确认用户已授权 git 版本控制；未获授权则跳过全部 commit 步骤，仅执行验证。

## 文件结构

| 文件 | 职责 |
|---|---|
| `manifest.json` | MV3 声明、权限、service worker、action |
| `package.json` | `type: module` 与 `npm test` 脚本，无依赖 |
| `.gitignore` | 忽略 `node_modules/`、日志 |
| `lib/verdict.js` | `isCheckable`、`classify`、`VERDICT` 常量 |
| `lib/scanner.js` | `probeUrl`、`runScan`、并发池、URL 去重、取消 |
| `lib/bookmark-tree.js` | `collectBookmarks`、`sortResults`、根分类映射 |
| `lib/backup.js` | `buildBackup`、`trimBackups`、`buildRestorePlan` |
| `background.js` | 消息路由、扫描会话、keepalive、删除、备份、恢复 |
| `app.html` / `app.css` / `app.js` | 全页 UI |
| `tests/verdict.test.js` | 判定单测 |
| `tests/scanner.test.js` | 探测与并发单测（注入 fetch stub） |
| `tests/bookmark-tree.test.js` | 树遍历与排序单测 |
| `tests/backup.test.js` | 备份与恢复计划单测 |
| `README.md` | 安装、使用、测试说明 |

---

### Task 1: 项目初始化与判定模块

**Files:**
- Create: `package.json`, `.gitignore`, `lib/verdict.js`, `tests/verdict.test.js`

**Interfaces:**
- Produces: `VERDICT`（`{ OK:'ok', BROKEN:'broken', SUSPICIOUS:'suspicious', SKIPPED:'skipped' }`）、`isCheckable(url: string): boolean`、`classify({ httpStatus?: number|null, error?: string|null }): 'ok'|'broken'|'suspicious'`。后续 `scanner.js` 从本模块导入 `isCheckable`、`classify`。

- [ ] **Step 1: 初始化项目文件**

创建 `package.json`：

```json
{
  "name": "bookmark-checker",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
```

创建 `.gitignore`：

```
node_modules/
*.log
```

（若用户已授权版本控制，此处执行 `git init`。）

- [ ] **Step 2: 写失败的测试**

创建 `tests/verdict.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { VERDICT, isCheckable, classify } from '../lib/verdict.js';

test('isCheckable 接受 http 与 https', () => {
  assert.equal(isCheckable('http://example.com'), true);
  assert.equal(isCheckable('https://example.com/path?q=1'), true);
  assert.equal(isCheckable('HTTPS://EXAMPLE.COM'), true);
});

test('isCheckable 拒绝非 web 协议与非法 URL', () => {
  assert.equal(isCheckable('chrome://settings'), false);
  assert.equal(isCheckable('file:///C:/x.html'), false);
  assert.equal(isCheckable('javascript:void(0)'), false);
  assert.equal(isCheckable('about:blank'), false);
  assert.equal(isCheckable('not a url'), false);
  assert.equal(isCheckable(''), false);
});

test('classify 将 2xx/3xx 判为 ok', () => {
  assert.equal(classify({ httpStatus: 200 }), VERDICT.OK);
  assert.equal(classify({ httpStatus: 204 }), VERDICT.OK);
  assert.equal(classify({ httpStatus: 301 }), VERDICT.OK);
});

test('classify 将 404/410 判为 broken', () => {
  assert.equal(classify({ httpStatus: 404 }), VERDICT.BROKEN);
  assert.equal(classify({ httpStatus: 410 }), VERDICT.BROKEN);
});

test('classify 将 5xx 判为 broken', () => {
  assert.equal(classify({ httpStatus: 500 }), VERDICT.BROKEN);
  assert.equal(classify({ httpStatus: 503 }), VERDICT.BROKEN);
});

test('classify 将 401/403/407/429 及其余 4xx 判为 suspicious', () => {
  for (const status of [400, 401, 403, 405, 407, 429, 451]) {
    assert.equal(classify({ httpStatus: status }), VERDICT.SUSPICIOUS);
  }
});

test('classify 将超时与网络错误判为 broken', () => {
  assert.equal(classify({ error: 'timeout' }), VERDICT.BROKEN);
  assert.equal(classify({ error: 'network' }), VERDICT.BROKEN);
});

test('classify 缺失状态码时保守判为 broken', () => {
  assert.equal(classify({}), VERDICT.BROKEN);
  assert.equal(classify(), VERDICT.BROKEN);
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `node --test tests/verdict.test.js`
Expected: FAIL，报错 `Cannot find module .../lib/verdict.js`。

- [ ] **Step 4: 实现 lib/verdict.js**

```js
export const VERDICT = {
  OK: 'ok',
  BROKEN: 'broken',
  SUSPICIOUS: 'suspicious',
  SKIPPED: 'skipped',
};

export function isCheckable(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function classify({ httpStatus = null, error = null } = {}) {
  if (error === 'timeout' || error === 'network') return VERDICT.BROKEN;
  if (!Number.isInteger(httpStatus)) return VERDICT.BROKEN;
  if (httpStatus >= 200 && httpStatus < 400) return VERDICT.OK;
  if (httpStatus === 404 || httpStatus === 410) return VERDICT.BROKEN;
  if (httpStatus >= 500 && httpStatus < 600) return VERDICT.BROKEN;
  return VERDICT.SUSPICIOUS;
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test tests/verdict.test.js`
Expected: PASS，8 个测试全部通过。

- [ ] **Step 6: 提交（仅在用户授权版本控制时）**

```bash
git add package.json .gitignore lib/verdict.js tests/verdict.test.js
git commit -m "feat: add bookmark verdict classification module"
```

---

### Task 2: 探测与并发扫描

**Files:**
- Create: `lib/scanner.js`, `tests/scanner.test.js`

**Interfaces:**
- Consumes: `isCheckable`、`classify`（Task 1）。
- Produces:
  - `DEFAULT_TIMEOUT_MS = 15000`、`DEFAULT_CONCURRENCY = 8`
  - `probeUrl(url, { fetchImpl?, timeoutMs?, signal? }) → Promise<{ verdict, httpStatus: number|null, finalUrl: string|null, error: 'timeout'|'network'|null }>`
  - `runScan({ items, fetchImpl?, concurrency?, timeoutMs?, signal?, onResult? }) → Promise<CheckResult[]>`

- [ ] **Step 1: 写失败的测试**

创建 `tests/scanner.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { probeUrl, runScan } from '../lib/scanner.js';

function makeFetch(handler) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      const result = await handler(url, options);
      return {
        status: result.status,
        url: result.url ?? url,
        body: { cancel: async () => {} },
      };
    } finally {
      inFlight -= 1;
    }
  };
  return { fetchImpl, calls, getMaxInFlight: () => maxInFlight };
}

const items = (urls) => urls.map((url, i) => ({
  bookmarkId: String(i + 1),
  title: `书签${i + 1}`,
  url,
  rootKind: 'toolbar',
  folderPath: [],
}));

test('HEAD 成功时不发 GET', async () => {
  const { fetchImpl, calls } = makeFetch(async () => ({ status: 200 }));
  const result = await probeUrl('https://ok.example', { fetchImpl });
  assert.equal(result.verdict, 'ok');
  assert.equal(result.httpStatus, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'HEAD');
});

test('HEAD 404 后用 GET 复核，GET 200 判 ok', async () => {
  const { fetchImpl, calls } = makeFetch(async (_url, options) => ({
    status: options.method === 'HEAD' ? 404 : 200,
  }));
  const result = await probeUrl('https://revived.example', { fetchImpl });
  assert.equal(result.verdict, 'ok');
  assert.deepEqual(calls.map((c) => c.method), ['HEAD', 'GET']);
});

test('HEAD 403 且 GET 403 判 suspicious', async () => {
  const { fetchImpl } = makeFetch(async () => ({ status: 403 }));
  const result = await probeUrl('https://blocked.example', { fetchImpl });
  assert.equal(result.verdict, 'suspicious');
  assert.equal(result.httpStatus, 403);
});

test('HEAD 超时直接判 broken，不再复核', async () => {
  let count = 0;
  const fetchImpl = async () => {
    count += 1;
    const err = new Error('timeout');
    err.name = 'TimeoutError';
    throw err;
  };
  const result = await probeUrl('https://slow.example', { fetchImpl });
  assert.equal(result.verdict, 'broken');
  assert.equal(result.error, 'timeout');
  assert.equal(count, 1);
});

test('HEAD 网络错误后用 GET 复核，GET 仍失败判 broken/network', async () => {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    calls.push(options.method);
    throw new Error('dns failure');
  };
  const result = await probeUrl('https://dead.example', { fetchImpl });
  assert.equal(result.verdict, 'broken');
  assert.equal(result.error, 'network');
  assert.deepEqual(calls, ['HEAD', 'GET']);
});

test('非 http(s) URL 判 skipped 且不发请求', async () => {
  const { fetchImpl, calls } = makeFetch(async () => ({ status: 200 }));
  const result = await probeUrl('chrome://settings', { fetchImpl });
  assert.equal(result.verdict, 'skipped');
  assert.equal(calls.length, 0);
});

test('同 URL 多书签共享一次探测', async () => {
  const { fetchImpl, calls } = makeFetch(async () => ({ status: 200 }));
  const results = await runScan({
    items: items(['https://same.example', 'https://same.example']),
    fetchImpl,
  });
  assert.equal(results.length, 2);
  assert.equal(calls.length, 1);
  assert.equal(results[0].verdict, 'ok');
  assert.equal(results[1].verdict, 'ok');
});

test('并发池同时请求数不超过上限', async () => {
  const { fetchImpl, getMaxInFlight } = makeFetch(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { status: 200 };
  });
  const urls = Array.from({ length: 20 }, (_, i) => `https://c${i}.example`);
  const results = await runScan({ items: items(urls), fetchImpl, concurrency: 8 });
  assert.equal(results.length, 20);
  assert.ok(getMaxInFlight() <= 8, `max in flight = ${getMaxInFlight()}`);
});

test('已取消的信号不发起任何请求', async () => {
  const { fetchImpl, calls } = makeFetch(async () => ({ status: 200 }));
  const controller = new AbortController();
  controller.abort();
  const results = await runScan({
    items: items(['https://a.example', 'https://b.example']),
    fetchImpl,
    signal: controller.signal,
  });
  assert.deepEqual(results, []);
  assert.equal(calls.length, 0);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/scanner.test.js`
Expected: FAIL，`Cannot find module .../lib/scanner.js`。

- [ ] **Step 3: 实现 lib/scanner.js**

```js
import { isCheckable, classify } from './verdict.js';

export const DEFAULT_TIMEOUT_MS = 15000;
export const DEFAULT_CONCURRENCY = 8;

async function request(url, method, fetchImpl, timeoutMs, outerSignal) {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (outerSignal) signals.push(outerSignal);
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

  let response;
  try {
    response = await fetchImpl(url, { method, redirect: 'follow', signal });
  } catch (err) {
    if (outerSignal?.aborted) throw err;
    if (err?.name === 'TimeoutError') return { error: 'timeout' };
    return { error: 'network' };
  }

  if (method === 'GET' && response.body) {
    try {
      await response.body.cancel();
    } catch {
      // 响应体已结束或不可取消，忽略
    }
  }
  return { error: null, httpStatus: response.status, finalUrl: response.url || url };
}

export async function probeUrl(url, options = {}) {
  const { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, signal = null } = options;
  if (!isCheckable(url)) {
    return { verdict: 'skipped', httpStatus: null, finalUrl: null, error: null };
  }

  const head = await request(url, 'HEAD', fetchImpl, timeoutMs, signal);
  if (!head.error && head.httpStatus >= 200 && head.httpStatus < 400) {
    return { verdict: 'ok', httpStatus: head.httpStatus, finalUrl: head.finalUrl, error: null };
  }
  if (head.error === 'timeout') {
    return { verdict: 'broken', httpStatus: null, finalUrl: null, error: 'timeout' };
  }

  const get = await request(url, 'GET', fetchImpl, timeoutMs, signal);
  if (get.error) {
    return { verdict: 'broken', httpStatus: null, finalUrl: null, error: get.error };
  }
  return {
    verdict: classify({ httpStatus: get.httpStatus }),
    httpStatus: get.httpStatus,
    finalUrl: get.finalUrl,
    error: null,
  };
}

export async function runScan(options) {
  const {
    items,
    fetchImpl = fetch,
    concurrency = DEFAULT_CONCURRENCY,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal = null,
    onResult = () => {},
  } = options;

  const slots = new Array(items.length);
  const cache = new Map();
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      if (signal?.aborted) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      const item = items[index];

      let probe = cache.get(item.url);
      if (!probe) {
        probe = probeUrl(item.url, { fetchImpl, timeoutMs, signal });
        cache.set(item.url, probe);
      }

      let base;
      try {
        base = await probe;
      } catch (err) {
        if (signal?.aborted) return;
        base = { verdict: 'broken', httpStatus: null, finalUrl: null, error: 'network' };
      }

      const result = {
        bookmarkId: item.bookmarkId,
        title: item.title,
        url: item.url,
        rootKind: item.rootKind,
        folderPath: item.folderPath,
        ...base,
        checkedAt: Date.now(),
      };
      slots[index] = result;
      onResult(result);
    }
  };

  const workerCount = Math.min(concurrency, Math.max(items.length, 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return slots.filter(Boolean);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/scanner.test.js`
Expected: PASS，9 个测试全部通过。

- [ ] **Step 5: 运行全部测试**

Run: `node --test`
Expected: 17 个测试全部通过。

- [ ] **Step 6: 提交（仅在用户授权版本控制时）**

```bash
git add lib/scanner.js tests/scanner.test.js
git commit -m "feat: add link probing with HEAD/GET fallback and bounded concurrency"
```

---

### Task 3: 书签树遍历与结果排序

**Files:**
- Create: `lib/bookmark-tree.js`, `tests/bookmark-tree.test.js`

**Interfaces:**
- Produces:
  - `ROOT_KIND_BY_ID`（`{ '1':'toolbar', '2':'other', '3':'mobile' }`）
  - `collectBookmarks(tree, selectedIds: string[]): ScanItem[]`（`ScanItem = { bookmarkId, title, url, rootKind, folderPath }`；传 `['0']` 表示全部）
  - `sortResults(results: CheckResult[]): CheckResult[]`（失效→可疑→可用→跳过，同档保持原序）

- [ ] **Step 1: 写失败的测试**

创建 `tests/bookmark-tree.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectBookmarks, sortResults, ROOT_KIND_BY_ID } from '../lib/bookmark-tree.js';

const tree = [{
  id: '0',
  title: '',
  children: [
    {
      id: '1',
      title: '书签栏',
      children: [
        {
          id: '10',
          title: 'A',
          children: [
            { id: '100', title: 'a1', url: 'https://a1.example' },
            { id: '101', title: 'a2', url: 'chrome://settings' },
          ],
        },
        { id: '11', title: 'b1', url: 'https://b1.example' },
      ],
    },
    { id: '2', title: '其他书签', children: [] },
    { id: '3', title: '移动设备书签', children: [] },
  ],
}];

test('根节点 ID 映射正确', () => {
  assert.deepEqual(ROOT_KIND_BY_ID, { '1': 'toolbar', '2': 'other', '3': 'mobile' });
});

test('传 [0] 收集全部书签（含非 http(s)）', () => {
  const items = collectBookmarks(tree, ['0']);
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((i) => i.url), [
    'https://a1.example',
    'chrome://settings',
    'https://b1.example',
  ]);
});

test('选中文件夹只收其子树，路径与根类型正确', () => {
  const items = collectBookmarks(tree, ['10']);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0].folderPath, ['A']);
  assert.equal(items[0].rootKind, 'toolbar');
  assert.equal(items[0].bookmarkId, '100');
});

test('选中根节点收集整根', () => {
  assert.equal(collectBookmarks(tree, ['1']).length, 3);
  assert.equal(collectBookmarks(tree, ['2']).length, 0);
});

test('父子同时选中不产生重复', () => {
  assert.equal(collectBookmarks(tree, ['1', '10']).length, 3);
});

test('sortResults 按失效、可疑、可用、跳过排序且同档稳定', () => {
  const results = [
    { bookmarkId: '1', verdict: 'ok' },
    { bookmarkId: '2', verdict: 'broken' },
    { bookmarkId: '3', verdict: 'skipped' },
    { bookmarkId: '4', verdict: 'suspicious' },
    { bookmarkId: '5', verdict: 'broken' },
  ];
  assert.deepEqual(sortResults(results).map((r) => r.bookmarkId), ['2', '5', '4', '1', '3']);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/bookmark-tree.test.js`
Expected: FAIL，`Cannot find module .../lib/bookmark-tree.js`。

- [ ] **Step 3: 实现 lib/bookmark-tree.js**

```js
export const ROOT_KIND_BY_ID = { '1': 'toolbar', '2': 'other', '3': 'mobile' };

const VERDICT_RANK = { broken: 0, suspicious: 1, ok: 2, skipped: 3 };

export function collectBookmarks(tree, selectedIds) {
  const selected = new Set(selectedIds);
  const seen = new Set();
  const items = [];

  const visit = (node, rootKind, path, active) => {
    const isRootNode = node.id === '0' || ROOT_KIND_BY_ID[node.id] !== undefined;
    const nextRootKind = ROOT_KIND_BY_ID[node.id] ?? rootKind;

    if (node.url) {
      if (active && nextRootKind && !seen.has(node.id)) {
        seen.add(node.id);
        items.push({
          bookmarkId: node.id,
          title: node.title,
          url: node.url,
          rootKind: nextRootKind,
          folderPath: [...path],
        });
      }
      return;
    }

    const nextActive = active || selected.has(node.id);
    const nextPath = isRootNode ? path : [...path, node.title];
    for (const child of node.children ?? []) {
      visit(child, nextRootKind, nextPath, nextActive);
    }
  };

  if (tree[0]) visit(tree[0], null, [], false);
  return items;
}

export function sortResults(results) {
  return results
    .map((result, index) => ({ result, index }))
    .sort((a, b) => {
      const rankDiff = (VERDICT_RANK[a.result.verdict] ?? 9) - (VERDICT_RANK[b.result.verdict] ?? 9);
      return rankDiff !== 0 ? rankDiff : a.index - b.index;
    })
    .map((entry) => entry.result);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/bookmark-tree.test.js`
Expected: PASS，6 个测试全部通过。

- [ ] **Step 5: 提交（仅在用户授权版本控制时）**

```bash
git add lib/bookmark-tree.js tests/bookmark-tree.test.js
git commit -m "feat: add bookmark tree traversal and result sorting"
```

---

### Task 4: 备份生成、轮转与恢复计划

**Files:**
- Create: `lib/backup.js`, `tests/backup.test.js`

**Interfaces:**
- Produces:
  - `MAX_BACKUPS = 10`
  - `buildBackup(items, { id, now?, reason? }) → Backup`（`Backup = { id, version:1, createdAt, reason, count, items: [{ title, url, rootKind, path }] }`）
  - `trimBackups(backups, max?) → Backup[]`（按 `createdAt` 降序，最多 `max` 份）
  - `buildRestorePlan(backup, tree) → RestoreEntry[]`（`RestoreEntry = { item, rootId, folders: [{ title, existingId }], missingRoot }`）

- [ ] **Step 1: 写失败的测试**

创建 `tests/backup.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_BACKUPS, buildBackup, trimBackups, buildRestorePlan } from '../lib/backup.js';

test('buildBackup 抽取字段并计数', () => {
  const items = [
    { bookmarkId: '1', title: '旧站', url: 'https://old.example', rootKind: 'toolbar', folderPath: ['技术', '前端'], verdict: 'broken' },
  ];
  const backup = buildBackup(items, { id: 'bk_1', now: 1000 });
  assert.equal(backup.id, 'bk_1');
  assert.equal(backup.version, 1);
  assert.equal(backup.createdAt, 1000);
  assert.equal(backup.reason, 'cleanup');
  assert.equal(backup.count, 1);
  assert.deepEqual(backup.items, [
    { title: '旧站', url: 'https://old.example', rootKind: 'toolbar', path: ['技术', '前端'] },
  ]);
});

test('trimBackups 保留最新 10 份', () => {
  const list = Array.from({ length: 12 }, (_, i) => ({ id: `bk_${i}`, createdAt: i }));
  const trimmed = trimBackups(list);
  assert.equal(trimmed.length, MAX_BACKUPS);
  assert.equal(trimmed[0].id, 'bk_11');
  assert.equal(trimmed[9].id, 'bk_2');
});

const tree = [{
  id: '0',
  title: '',
  children: [
    {
      id: '1',
      title: '书签栏',
      children: [
        {
          id: '10',
          title: '技术',
          children: [{ id: '11', title: '前端', children: [] }],
        },
      ],
    },
    { id: '2', title: '其他书签', children: [] },
  ],
}];

test('buildRestorePlan 解析已存在与需新建的文件夹', () => {
  const backup = {
    items: [
      { title: 'X', url: 'https://x.example', rootKind: 'toolbar', path: ['技术', '前端'] },
      { title: 'Y', url: 'https://y.example', rootKind: 'toolbar', path: ['技术', '新目录', '深层'] },
      { title: 'Z', url: 'https://z.example', rootKind: 'mobile', path: [] },
    ],
  };
  const plan = buildRestorePlan(backup, tree);
  assert.equal(plan.length, 3);

  assert.equal(plan[0].rootId, '1');
  assert.equal(plan[0].missingRoot, false);
  assert.deepEqual(plan[0].folders, [
    { title: '技术', existingId: '10' },
    { title: '前端', existingId: '11' },
  ]);

  assert.equal(plan[1].folders[0].existingId, '10');
  assert.equal(plan[1].folders[1].existingId, null);
  assert.equal(plan[1].folders[2].existingId, null);

  assert.equal(plan[2].missingRoot, true);
  assert.equal(plan[2].rootId, null);
});

test('buildRestorePlan 对空路径直接落在根下', () => {
  const backup = {
    items: [{ title: 'R', url: 'https://r.example', rootKind: 'other', path: [] }],
  };
  const plan = buildRestorePlan(backup, tree);
  assert.equal(plan[0].rootId, '2');
  assert.deepEqual(plan[0].folders, []);
  assert.equal(plan[0].missingRoot, false);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/backup.test.js`
Expected: FAIL，`Cannot find module .../lib/backup.js`。

- [ ] **Step 3: 实现 lib/backup.js**

```js
export const MAX_BACKUPS = 10;

const ROOT_IDS = { toolbar: '1', other: '2', mobile: '3' };

export function buildBackup(items, { id, now = Date.now(), reason = 'cleanup' } = {}) {
  return {
    id: id ?? `bk_${now}`,
    version: 1,
    createdAt: now,
    reason,
    count: items.length,
    items: items.map(({ title, url, rootKind, folderPath }) => ({
      title,
      url,
      rootKind,
      path: [...folderPath],
    })),
  };
}

export function trimBackups(backups, max = MAX_BACKUPS) {
  return [...backups].sort((a, b) => b.createdAt - a.createdAt).slice(0, max);
}

export function buildRestorePlan(backup, tree) {
  const rootChildren = tree[0]?.children ?? [];
  const rootById = new Map(rootChildren.map((node) => [node.id, node]));

  return backup.items.map((item) => {
    const rootId = ROOT_IDS[item.rootKind] ?? null;
    const rootNode = rootId ? rootById.get(rootId) : null;
    if (!rootNode) {
      return { item, rootId: null, folders: [], missingRoot: true };
    }

    const folders = [];
    let parentNode = rootNode;
    for (const title of item.path.filter(Boolean)) {
      const found = parentNode
        ? (parentNode.children ?? []).find((child) => !child.url && child.title === title)
        : null;
      folders.push({ title, existingId: found ? found.id : null });
      parentNode = found ?? null;
    }
    return { item, rootId, folders, missingRoot: false };
  });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/backup.test.js`
Expected: PASS，4 个测试全部通过。

- [ ] **Step 5: 运行全部测试**

Run: `node --test`
Expected: 27 个测试全部通过。

- [ ] **Step 6: 提交（仅在用户授权版本控制时）**

```bash
git add lib/backup.js tests/backup.test.js
git commit -m "feat: add backup creation, rotation and restore planning"
```

---

### Task 5: Manifest 与 Service Worker

**Files:**
- Create: `manifest.json`, `background.js`

**Interfaces:**
- Consumes: `runScan`（Task 2）、`buildBackup` / `trimBackups` / `buildRestorePlan` / `MAX_BACKUPS`（Task 4）。
- Produces：消息协议（供 Task 7 调用）：
  - UI→后台：`START_SCAN`、`GET_SCAN_STATE`、`CANCEL_SCAN`、`DELETE_BOOKMARKS`、`CREATE_BACKUP`、`LIST_BACKUPS`、`GET_BACKUP`、`RESTORE_BACKUP`
  - 端口 `scan` 广播：`SNAPSHOT`、`PROGRESS`、`ITEM_RESULT`、`SCAN_DONE`

- [ ] **Step 1: 创建 manifest.json**

```json
{
  "manifest_version": 3,
  "name": "书签失效检测器",
  "version": "0.1.0",
  "minimum_chrome_version": "116",
  "description": "检测书签链接可用性，标记失效与可疑，支持单项删除与一键清理（自动备份）。",
  "permissions": ["bookmarks", "storage"],
  "host_permissions": ["http://*/*", "https://*/*"],
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "action": {
    "default_title": "书签失效检测器"
  }
}
```

- [ ] **Step 2: 实现 background.js**

```js
import { runScan } from './lib/scanner.js';
import { buildBackup, trimBackups, buildRestorePlan, MAX_BACKUPS } from './lib/backup.js';

const SNAPSHOT_KEY = 'lastScan';
const BACKUPS_KEY = 'backups';
const KEEPALIVE_MS = 25000;
const SNAPSHOT_EVERY = 50;

let activeScan = null;
let scanPort = null;

function broadcast(message) {
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
```

- [ ] **Step 3: 语法与清单校验**

Run: `node --check background.js`
Expected: 无输出，退出码 0。

Run: `node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest ok')"`
Expected: 输出 `manifest ok`。

- [ ] **Step 4: 提交（仅在用户授权版本控制时）**

```bash
git add manifest.json background.js
git commit -m "feat: add MV3 manifest and background service worker"
```

---

### Task 6: 全页 UI 骨架与样式

**Files:**
- Create: `app.html`, `app.css`

**Interfaces:**
- Produces: DOM 契约（Task 7 依赖的 `id`）：`scan-all`、`cancel-scan`、`progress`、`progress-bar`、`progress-text`、`stats`、`bookmark-tree`、`select-all`、`select-none`、`selected-count`、`scan-selected`、`last-scan`、`filters`、`cleanup`、`results`、`empty`、`toggle-backups`、`backup-list`、`modal-root`、`modal-title`、`modal-body`、`modal-cancel`、`modal-confirm`。

- [ ] **Step 1: 创建 app.html**

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>书签失效检测器</title>
  <link rel="stylesheet" href="app.css">
</head>
<body>
  <header class="topbar">
    <div class="brand">书签失效检测器</div>
    <div class="topbar-actions">
      <button id="scan-all" class="btn primary">扫描全部</button>
      <button id="cancel-scan" class="btn danger hidden">取消扫描</button>
    </div>
    <div id="progress" class="progress hidden">
      <div class="progress-track"><div id="progress-bar" class="progress-bar"></div></div>
      <span id="progress-text" class="progress-text"></span>
    </div>
    <div id="stats" class="stats"></div>
  </header>

  <main class="layout">
    <aside class="sidebar">
      <div class="sidebar-head">
        <span>书签</span>
        <span class="sidebar-actions">
          <button id="select-all" class="link-btn">全选</button>
          <button id="select-none" class="link-btn">清空</button>
        </span>
      </div>
      <div id="bookmark-tree" class="tree"></div>
      <div class="sidebar-foot">
        <span id="selected-count">已选 0 个链接</span>
        <button id="scan-selected" class="btn primary">扫描所选</button>
      </div>
    </aside>

    <section class="content">
      <div id="last-scan" class="last-scan"></div>
      <div class="bulkbar">
        <nav id="filters" class="filters"></nav>
        <button id="cleanup" class="btn danger-outline" disabled>一键清理失效（0）</button>
      </div>
      <div id="results" class="results"></div>
      <div id="empty" class="empty">暂无结果，请选择范围后开始扫描。</div>
      <section class="backups">
        <button id="toggle-backups" class="link-btn">备份记录</button>
        <div id="backup-list" class="backup-list hidden"></div>
      </section>
    </section>
  </main>

  <div id="modal-root" class="modal-root hidden">
    <div class="modal-backdrop"></div>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <h3 id="modal-title"></h3>
      <div id="modal-body"></div>
      <div class="modal-actions">
        <button id="modal-cancel" class="btn">取消</button>
        <button id="modal-confirm" class="btn danger">确认</button>
      </div>
    </div>
  </div>

  <script type="module" src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: 创建 app.css**

```css
:root {
  color-scheme: light dark;
  --bg: #f5f5f3;
  --surface: #fbfbf9;
  --surface-2: #efefec;
  --line: #e2e2de;
  --line-strong: #cfcfc9;
  --text: #1b1b19;
  --muted: #6e6e67;
  --strong: #171715;
  --strong-text: #fbfbf9;
  --danger: #b3261e;
  --danger-solid: #a92a20;
  --danger-soft: #fbeeec;
  --warn: #9a5b08;
  --ok: #1f6f43;
  --skip: #74746c;
  --focus: #171715;
  --radius-panel: 10px;
  --radius-control: 7px;
  --font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI Variable Text", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  --font-mono: ui-monospace, "Cascadia Mono", "SFMono-Regular", Consolas, monospace;
  --ease: cubic-bezier(0.2, 0, 0, 1);
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111210;
    --surface: #181917;
    --surface-2: #202220;
    --line: #2c2e2b;
    --line-strong: #3a3d39;
    --text: #e8e8e3;
    --muted: #9a9c95;
    --strong: #e8e8e3;
    --strong-text: #141513;
    --danger: #e5766d;
    --danger-soft: #2a1a18;
    --warn: #d0a24a;
    --ok: #6db98c;
    --skip: #9a9c95;
    --focus: #e8e8e3;
  }
}

* { box-sizing: border-box; }

body {
  margin: 0;
  font-family: var(--font-sans);
  font-size: 13.5px;
  line-height: 1.5;
  background: var(--bg);
  color: var(--text);
  min-height: 100vh;
  -webkit-font-smoothing: antialiased;
}

button, input { font: inherit; color: inherit; }

.hidden { display: none !important; }

:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

.topbar {
  display: flex;
  align-items: center;
  gap: 18px;
  min-height: 60px;
  padding: 10px 24px;
  background: var(--surface);
  border-bottom: 1px solid var(--line);
  position: sticky;
  top: 0;
  z-index: 10;
  flex-wrap: wrap;
}

.brand { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }

.topbar-actions { display: flex; gap: 8px; order: 3; }

.progress { flex: 1 1 280px; display: flex; align-items: center; gap: 10px; min-width: 220px; order: 1; }

.progress-track {
  flex: 1;
  height: 4px;
  background: var(--surface-2);
  border-radius: 2px;
  overflow: hidden;
}

.progress-bar {
  height: 100%;
  width: 0;
  background: var(--strong);
  transition: width 0.18s var(--ease);
}

.progress-text {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--muted);
  max-width: 380px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stats { display: flex; gap: 16px; margin-left: auto; order: 2; }
.stats span { display: inline-flex; align-items: baseline; gap: 5px; }
.stats strong { font-family: var(--font-mono); font-size: 15px; font-weight: 600; color: var(--text); font-variant-numeric: tabular-nums; }
.stats .stat-label { font-size: 11.5px; color: var(--muted); }
.stats .s-broken strong { color: var(--danger); }
.stats .s-suspicious strong { color: var(--warn); }
.stats .s-ok strong { color: var(--ok); }
.stats .s-skipped strong { color: var(--skip); }

.layout {
  display: grid;
  grid-template-columns: 296px minmax(0, 1fr);
  gap: 20px;
  padding: 20px 24px 48px;
  align-items: start;
  max-width: 1500px;
  margin: 0 auto;
}

.sidebar {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 100px);
  position: sticky;
  top: 80px;
}

.sidebar-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 11px 14px;
  border-bottom: 1px solid var(--line);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--muted);
}

.sidebar-actions { display: flex; gap: 12px; }

.sidebar-foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--line);
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--muted);
}

.tree { overflow: auto; padding: 8px 8px 12px; flex: 1; }
.tree-node { margin: 0; }
.tree-node .tree-node { margin-left: 16px; }
.tree-row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 6px;
  border-radius: 5px;
  cursor: pointer;
  line-height: 1.35;
}
.tree-row:hover { background: var(--surface-2); }
.tree-row input { accent-color: var(--strong); margin: 0; }
.tree-leaf {
  margin-left: 24px;
  padding: 3px 6px;
  font-size: 12.5px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  border-radius: 5px;
}
.tree-leaf:hover { background: var(--surface-2); color: var(--text); }

.content { display: flex; flex-direction: column; gap: 12px; min-width: 0; }

.last-scan { font-family: var(--font-mono); font-size: 11.5px; color: var(--muted); min-height: 17px; }

.bulkbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.filters {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  background: var(--surface-2);
  border-radius: var(--radius-control);
  flex-wrap: wrap;
}

.filter {
  border: 0;
  background: transparent;
  color: var(--muted);
  border-radius: 5px;
  padding: 5px 11px;
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  transition: color 0.12s var(--ease), background-color 0.12s var(--ease);
}

.filter:hover { color: var(--text); }

.filter.active {
  background: var(--surface);
  color: var(--text);
  box-shadow: inset 0 0 0 1px var(--line);
}

.bulkbar #cleanup { margin-left: auto; }

.results {
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  overflow: hidden;
}

.result-row {
  --status: var(--skip);
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 14px;
  align-items: center;
  padding: 11px 14px 11px 16px;
  box-shadow: inset 3px 0 0 var(--status);
  border-bottom: 1px solid var(--line);
}
.result-row:last-child { border-bottom: 0; }
.result-row:hover { background: var(--surface-2); }
.result-row.verdict-broken { --status: var(--danger); }
.result-row.verdict-suspicious { --status: var(--warn); }
.result-row.verdict-ok { --status: var(--ok); }
.result-row.verdict-skipped { --status: var(--skip); }

.result-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.result-main a {
  color: var(--text);
  font-weight: 500;
  text-decoration: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.result-main a:hover { text-decoration: underline; text-underline-offset: 2px; }
.result-url {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.badge {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--status);
  white-space: nowrap;
  padding: 2px 0;
}

.empty {
  padding: 56px 16px;
  text-align: center;
  color: var(--muted);
  background: transparent;
  border: 1px dashed var(--line-strong);
  border-radius: var(--radius-panel);
}

.backups {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  padding: 10px 14px;
}
.backup-list { margin-top: 8px; display: flex; flex-direction: column; }
.backup-row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 7px 0;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--muted);
  border-top: 1px solid var(--line);
}
.backup-list .backup-row:first-child { border-top: 0; }
.backup-row span { flex: 1; }

.btn {
  border: 1px solid var(--line-strong);
  background: var(--surface);
  color: var(--text);
  border-radius: var(--radius-control);
  padding: 6px 13px;
  font-size: 12.5px;
  line-height: 1.4;
  cursor: pointer;
  transition: transform 0.12s var(--ease), background-color 0.12s var(--ease), border-color 0.12s var(--ease);
}
.btn:hover:not(:disabled) { border-color: var(--text); }
.btn:active:not(:disabled) { transform: translateY(1px); }
.btn:disabled { opacity: 0.45; cursor: not-allowed; }
.btn.primary { background: var(--strong); border-color: var(--strong); color: var(--strong-text); }
.btn.primary:hover:not(:disabled) { opacity: 0.9; }
.btn.danger { background: var(--danger-solid); border-color: var(--danger-solid); color: #fff; }
.btn.danger-outline { background: transparent; border-color: color-mix(in srgb, var(--danger) 45%, var(--line)); color: var(--danger); }
.btn.danger-outline:hover:not(:disabled) { background: var(--danger-soft); border-color: var(--danger); }
.btn.danger-ghost { border-color: transparent; background: transparent; color: var(--danger); }
.btn.danger-ghost:hover:not(:disabled) { background: var(--danger-soft); }
.btn.small { padding: 3px 8px; font-size: 12px; }

.link-btn {
  border: none;
  background: none;
  color: var(--muted);
  cursor: pointer;
  font-size: 12.5px;
  padding: 0;
  transition: color 0.12s var(--ease);
}
.link-btn:hover { color: var(--text); }

.modal-root { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; }
.modal-backdrop { position: absolute; inset: 0; background: rgba(12, 12, 10, 0.5); backdrop-filter: blur(2px); }
.modal {
  position: relative;
  background: var(--surface);
  border-radius: 12px;
  padding: 22px;
  width: min(480px, calc(100vw - 40px));
  border: 1px solid var(--line);
  box-shadow: 0 24px 60px rgba(20, 20, 16, 0.28);
  animation: modal-in 0.14s var(--ease);
}
@keyframes modal-in {
  from { opacity: 0; transform: translateY(4px) scale(0.99); }
  to { opacity: 1; transform: none; }
}
.modal h3 { margin: 0 0 12px; font-size: 16px; letter-spacing: -0.01em; }
.modal-body, #modal-body { font-size: 13.5px; line-height: 1.65; color: var(--text); word-break: break-word; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }

.muted { color: var(--muted); }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}

@media (prefers-reduced-transparency: reduce) {
  .modal-backdrop { backdrop-filter: none; }
}

@media (max-width: 900px) {
  .layout { grid-template-columns: 1fr; padding: 16px; }
  .sidebar { position: static; max-height: 42vh; }
  .progress { order: 1; flex-basis: 100%; }
  .topbar-actions { order: 2; }
  .stats { order: 3; margin-left: 0; }
}
```

- [ ] **Step 3: 校验页面结构可被解析**

Run: `node -e "const s=require('fs').readFileSync('app.html','utf8'); for (const id of ['scan-all','cancel-scan','progress','progress-bar','progress-text','stats','bookmark-tree','select-all','select-none','selected-count','scan-selected','last-scan','filters','cleanup','results','empty','toggle-backups','backup-list','modal-root','modal-title','modal-body','modal-cancel','modal-confirm']) { if (!s.includes('id=\"'+id+'\"')) throw new Error('缺少 id: '+id); } console.log('html ok')"`
Expected: 输出 `html ok`。

- [ ] **Step 4: 提交（仅在用户授权版本控制时）**

```bash
git add app.html app.css
git commit -m "feat: add full-page UI layout and styles"
```

---

### Task 7: 页面逻辑

**Files:**
- Create: `app.js`

**Interfaces:**
- Consumes: `collectBookmarks`、`sortResults`（Task 3）；Task 5 的消息协议；Task 6 的 DOM id。

- [ ] **Step 1: 实现 app.js**

```js
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
  const scanState = await chrome.runtime.sendMessage({ type: 'GET_SCAN_STATE' });
  const running = Boolean(scanState?.scanning);
  state.scanning = running;
  state.scanId = scanState?.scanId ?? state.lastScan.scanId ?? null;

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
```

- [ ] **Step 2: 语法检查**

Run: `node --check app.js`
Expected: 无输出，退出码 0。

- [ ] **Step 3: 运行全部单元测试**

Run: `node --test`
Expected: 27 个测试全部通过。

- [ ] **Step 4: 静态检查 HTML 契约与脚本引用**

Run: `node -e "const fs=require('fs'); const html=fs.readFileSync('app.html','utf8'); if(!html.includes('app.js')) throw new Error('缺少 app.js 引用'); if(!html.includes('app.css')) throw new Error('缺少 app.css 引用'); console.log('assets ok')"`
Expected: 输出 `assets ok`。

- [ ] **Step 5: 提交（仅在用户授权版本控制时）**

```bash
git add app.js
git commit -m "feat: implement full-page bookmark checker UI logic"
```

---

### Task 8: README 与手工验收

**Files:**
- Create: `README.md`

**Interfaces:**
- 无代码接口；产出安装与验收说明。

- [ ] **Step 1: 创建 README.md**

```markdown
# 书签失效检测器

Chrome 扩展（Manifest V3）：批量检测书签链接可达性，标记失效与可疑，支持单项删除、一键清理（自动备份）与从备份恢复。

## 安装

1. 打开 `chrome://extensions`；
2. 开启右上角「开发者模式」；
3. 点击「加载已解压的扩展程序」，选择本项目根目录；
4. 点击工具栏中的扩展图标，将在新标签页打开检测页面。

要求 Chrome 116 或更高版本。

## 使用

1. 左侧勾选书签文件夹（支持三态复选），或直接点击「扫描全部」；
2. 扫描期间可查看进度并随时取消；关闭页面不会中断扫描，重新打开可恢复结果；
3. 结果按「失效 / 可疑 / 可用 / 跳过」分类：
   - 失效：网络错误、超时、404/410、5xx；
   - 可疑：401/403/407/429 及其他 4xx（可能是反爬或需登录）；
   - 跳过：非 http(s) 链接。
4. 单项「删除」立即移除对应书签；
5. 「一键清理失效」仅删除确认失效项，删除前自动备份并下载 JSON 文件，备份同时保存在「备份记录」；
6. 「备份记录」可下载或恢复备份（保留最近 10 份）。

## 权限说明

- `bookmarks`：读取与删除书签；
- `storage`：保存扫描结果与备份；
- `host_permissions`（http/https）：在后台发起链接探测请求。

## 开发与测试

```bash
npm test          # 运行全部单元测试（node --test）
```

项目零第三方依赖，可直接以已解压扩展加载。

## 项目结构

- `lib/verdict.js`：链接判定规则；
- `lib/scanner.js`：HEAD/GET 探测与并发控制；
- `lib/bookmark-tree.js`：书签树遍历与排序；
- `lib/backup.js`：备份与恢复计划；
- `background.js`：service worker；
- `app.html` / `app.css` / `app.js`：全页界面；
- `docs/superpowers/`：设计规格与实现计划。
```

- [ ] **Step 2: 运行全部测试**

Run: `npm test`
Expected: 27 个测试全部通过。

- [ ] **Step 3: 手工验收（需真实 Chrome）**

加载上述已解压扩展，逐项检查：

1. 点击扩展图标打开全页；左侧书签树正确显示，勾选父文件夹时出现半选态，「全选/清空」生效；
2. 准备测试书签：一个正常网页、一个返回 404 的地址、一个需登录/403 的地址、一个 `chrome://settings` 书签；执行扫描后分别判为可用、失效、可疑、跳过；
3. 扫描期间进度条与当前 URL 更新；点击「取消扫描」后停止；
4. 关闭页面后重新打开，显示扫描快照与「上次扫描」时间；
5. 单项删除后，Chrome 书签管理器中该条目消失；
6. 一键清理：确认弹窗注明备份；执行后浏览器下载 `bookmark-checker-backup-*.json`，备份记录新增一条，失效项从书签管理器消失，可疑项保留；
7. 备份记录中点击「恢复」，书签回到原根与原文件夹路径；
8. 深色模式下界面可读，无原生 `confirm`/`alert` 弹窗。

- [ ] **Step 4: 提交（仅在用户授权版本控制时）**

```bash
git add README.md
git commit -m "docs: add README with install, usage and manual acceptance steps"
```

---

## 计划自审

- **Spec 覆盖**：范围确认（Task 1–3、7）、判定（Task 1–2）、扫描与会话（Task 2、5）、删除与清理（Task 5、7）、备份与恢复（Task 4、5、7）、UI 全部区域（Task 6–7）、错误与边界（Task 5、7）、测试与验收（Task 1–8）均有对应任务。
- **占位符**：无 TBD/TODO；所有代码与命令均为可直接执行的完整内容。
- **类型一致性**：`ScanItem`、`CheckResult`、`Backup`、`RestoreEntry` 字段在各任务间一致；消息 `type` 字符串与 Task 5 路由、Task 7 调用一致；DOM id 与 Task 6 契约一致。
