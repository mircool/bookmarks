# 书签失效检测器 — 设计规格

- 日期：2026-11-10
- 状态：待审阅
- 目标平台：Chrome（Manifest V3）

## 1. 背景与目标

Chrome 收藏夹中的链接会因站点下线、改版、域名迁移而失效，人工逐条排查成本高。本插件提供：

1. 批量检测书签链接可达性；
2. 按「可用 / 失效 / 可疑 / 跳过」四档分类展示；
3. 单个删除失效书签；
4. 一键清理全部确认失效项，清理前自动备份，支持从备份恢复。

## 2. 范围

### 做

- 可勾选文件夹（含全选/半选）或「扫描全部」；
- 后台并发扫描，实时进度，可取消，UI 关闭不中断；
- 结果持久化，重开页面恢复上次快照；
- 单项删除、批量清理（仅确认失效项）；
- 自动备份（最近 10 份），下载、恢复；
- 中文界面，深浅色跟随系统。

### 不做

- 软 404 检测（页面返回 200 但内容为“未找到”）；
- 定时自动扫描、失效告警；
- 云端同步、多账号；
- 非 http(s) 协议链接检测（标记为「跳过」）；
- 书签内容编辑、移动、去重。

## 3. 关键决策（已与需求方确认）

| 决策点 | 结论 |
|---|---|
| 主界面 | 独立全页，点击扩展图标在新标签页打开 |
| 扫描范围 | 可勾选文件夹，另有「扫描全部」入口 |
| 判定尺度 | 失效 + 可疑两档；可疑项不进入一键清理默认集 |
| 一键清理 | 仅清理确认失效项；清理前自动生成备份并下载，备份同时存于本地 |

## 4. 技术选型

- 原生 JavaScript（ES Modules）+ Manifest V3，零构建、零第三方依赖；
- 全页 UI 用原生 HTML/CSS/JS；
- 核心逻辑（判定、备份、扫描池）拆为可导入的纯 ES module，用 `node:test` 单测；
- 书签读写经 `chrome.bookmarks`，扫描在 service worker 中执行。

## 5. 文件结构

```
bookmark-checker/
  manifest.json
  package.json             # 仅 type: module 与 test 脚本，无依赖
  background.js            # service worker：消息路由、扫描调度、书签删除、备份存取
  lib/verdict.js           # isCheckable / classify / 判定常量
  lib/scanner.js           # probeUrl、并发池、扫描执行器（依赖注入 fetch）
  lib/backup.js            # 备份生成、恢复计划、备份轮转
  app.html                 # 全页 UI
  app.css
  app.js                   # UI 逻辑、书签树、结果列表、清理与恢复流程
  tests/verdict.test.js
  tests/scanner.test.js
  tests/backup.test.js
  README.md                # 安装与使用说明
  docs/superpowers/specs/2026-11-10-bookmark-link-checker-design.md
```

## 6. Manifest 与权限

```json
{
  "manifest_version": 3,
  "name": "书签失效检测器",
  "version": "0.1.0",
  "minimum_chrome_version": "116",
  "description": "检测书签链接可用性，标记失效与可疑，支持单项删除与一键清理（自动备份）。",
  "permissions": ["bookmarks", "storage"],
  "host_permissions": ["http://*/*", "https://*/*"],
  "background": { "service_worker": "background.js", "type": "module" },
  "action": { "default_title": "书签失效检测器" }
}
```

- `host_permissions` 使 service worker 的 `fetch` 不受 CORS 限制；
- 不申请 `downloads`：备份由 UI 侧 `Blob` + `<a download>` 触发；
- 不配 `default_popup`，由 `chrome.action.onClicked` 打开 `app.html`；
- 不提供自定义图标，Chrome 使用默认图标。

## 7. 数据模型

### 7.1 扫描项（UI 收集，发给后台）

```js
{
  bookmarkId: string,
  title: string,
  url: string,
  rootKind: 'toolbar' | 'other' | 'mobile',  // 书签栏 / 其他书签 / 移动设备书签
  folderPath: string[]                        // 根之下各层文件夹名，显示与恢复用
}
```

### 7.2 检测结果

```js
{
  bookmarkId: string,
  title: string,
  url: string,
  rootKind: 'toolbar' | 'other' | 'mobile',
  folderPath: string[],
  verdict: 'ok' | 'broken' | 'suspicious' | 'skipped',
  httpStatus: number | null,     // 最终响应状态码
  finalUrl: string | null,       // 跟随重定向后的地址
  error: string | null,          // 'timeout' | 'network'，verdict 为 broken 时说明原因
  checkedAt: number
}
```

### 7.3 扫描快照（`storage.local` 键 `lastScan`）

```js
{
  scanId: string,
  startedAt: number,
  finishedAt: number | null,
  status: 'running' | 'done' | 'cancelled',
  total: number,
  results: CheckResult[]
}
```

### 7.4 备份（`storage.local` 键 `backups`，数组，最新在前，最多 10 份）

```js
{
  id: string,
  version: 1,
  createdAt: number,
  reason: 'cleanup',
  count: number,
  items: [
    { title: string, url: string, rootKind: 'toolbar'|'other'|'mobile', path: string[] }
  ]
}
```

## 8. 消息协议（UI ↔ service worker）

UI → 后台（`chrome.runtime.sendMessage`，均返回 Promise）：

| type | 载荷 | 返回 |
|---|---|---|
| `START_SCAN` | `items: ScanItem[]` | `{ scanId }` |
| `GET_SCAN_STATE` | — | `{ scanning: boolean, scanId: string\|null }` |
| `CANCEL_SCAN` | `scanId` | `{ cancelled: boolean }` |
| `DELETE_BOOKMARKS` | `bookmarkIds: string[]` | `{ removed: string[], failed: [{id, error}] }` |
| `CREATE_BACKUP` | `items: BackupItem[]` | `{ backup: Backup }` |
| `LIST_BACKUPS` | — | `{ backups: BackupSummary[] }`（`{ id, createdAt, count, reason }`，不含条目明细） |
| `GET_BACKUP` | `id` | `{ backup: Backup }` |
| `RESTORE_BACKUP` | `backup: Backup` | `{ created: number, failed: [{title, error}] }` |

后台 → UI（`Port` 长连接，端口名 `scan`）：

| type | 载荷 |
|---|---|
| `SNAPSHOT` | `{ scanId, results: CheckResult[], done, total, status }`（UI 连接时若扫描运行中立即补发一次） |
| `PROGRESS` | `{ done, total, current: string }` |
| `ITEM_RESULT` | `{ result: CheckResult }` |
| `SCAN_DONE` | `{ status: 'done'|'cancelled', finishedAt }` |

- UI 未打开时端口不存在，后台照常扫描，结果写快照；
- UI 打开时直接读取 `storage.local` 的 `lastScan`；若快照为 running 且后台扫描仍在进行，UI 连接 `scan` 端口后后台立即补发 `SNAPSHOT`（内存中的完整结果，弥补快照落盘滞后），随后增量广播。

## 9. 扫描流程

1. UI 按书签 ID 去重后，递归收集选中文件夹下的全部书签（含非 http(s)，其判 `skipped`）；点击「扫描全部」则收集三个根下全部书签。
2. 发送 `START_SCAN`。后台创建 `scanId`、`AbortController`、并发池（并发上限 8），开始执行。
3. 每个 URL 探活：
   - 本次扫描内以 `Map<url, Promise<BaseResult>>` 去重，同 URL 的多个书签共享一次请求结果；
   - 结果回填各自书签的 `bookmarkId` 等字段。
4. 每完成一项：向已连接端口广播 `ITEM_RESULT` 与 `PROGRESS`；每 50 项将快照写入 `storage.local`（含 running 状态）。
5. 扫描期间每 25 秒调用一次 `chrome.runtime.getPlatformInfo()` 保活，防 MV3 worker 休眠；扫描结束清除定时器。
6. 全部完成或被取消：写入 `finishedAt`、`status`，广播 `SCAN_DONE`，清空内存态。
7. 取消：`AbortController.abort()` 中断全部在途请求，已完成结果保留并落盘。

## 10. 判定引擎

### 10.1 可检测性

仅 `http:`、`https:` 开头的 URL 检测；其余（`chrome://`、`file://`、`javascript:`、`about:` 等）直接判 `skipped`。

### 10.2 探测策略

先 `HEAD`，再按需 `GET` 复核：

| HEAD 结果 | 后续动作 |
|---|---|
| 最终 2xx/3xx | 判 `ok`，结束 |
| 超时（15s） | 判 `broken`（error=`timeout`），不再复核 |
| 网络错误（DNS/连接失败/TLS 等） | 用 `GET` 复核一次 |
| 其他 HTTP 状态（4xx/5xx） | 用 `GET` 复核，以 GET 结果为准 |

`GET` 复核结果处理：

| GET 结果 | verdict |
|---|---|
| 最终 2xx/3xx | `ok` |
| 最终 404 / 410 | `broken` |
| 最终 5xx | `broken` |
| 最终 401 / 403 / 407 / 429 | `suspicious` |
| 其他最终 4xx | `suspicious` |
| 超时 | `broken`（error=`timeout`） |
| 网络错误 | `broken`（error=`network`） |

- 请求参数：`redirect: 'follow'`，每个请求（HEAD 或 GET）各自 15 秒超时（`AbortSignal.timeout`），GET 拿到响应头后立即 `response.body.cancel()`，不下载响应体；
- 记录最终状态码与重定向后的 URL；`finalUrl !== url` 时在结果行展示最终地址；
- 判定函数 `classify({ httpStatus, error })` 为纯函数，便于单测。

### 10.3 结果排序

失效在前，其次可疑，再次可用，跳过最后；同档内保持书签原始顺序。

## 11. 删除、清理与恢复

### 11.1 单项删除

- 结果行「删除」→ 确认弹窗（显示标题与 URL，提示不可撤销）→ `DELETE_BOOKMARKS`（单个 ID）；
- 书签已不存在时视为成功；其他错误计入失败并提示；
- 后台删除成功后从 `lastScan.results` 移除对应项并写回 `storage.local`；UI 刷新结果列表与书签树。

### 11.2 一键清理

1. 收集当前快照中 `verdict === 'broken'` 的全部项；可疑项不进入一键清理，如需删除则走单项删除；
2. 确认弹窗：显示将删除数量，注明「删除前自动备份并下载备份文件」；
3. `CREATE_BACKUP`：后台生成备份，写入 `storage.local`（超过 10 份淘汰最旧），返回备份内容；
4. 备份写入成功后，UI 以 `Blob` 触发 `bookmark-checker-backup-<时间戳>.json` 下载；
5. 下载触发后调用 `DELETE_BOOKMARKS` 批量删除，逐项容错；
6. 结果提示：成功 N 条、失败 M 条；后台从 `lastScan.results` 移除已删项并写回 `storage.local`，UI 刷新列表与书签树；
7. 若备份写入 `storage.local` 失败，**中止清理**并报错。

### 11.3 备份与恢复

- 「备份记录」区展示最近 10 份备份：时间、条数、下载、恢复；
- 恢复流程：读备份 → 确认弹窗 → `RESTORE_BACKUP`；
- 恢复算法（纯函数 `buildRestorePlan` 产出计划，后台执行）：
  1. `rootKind` 映射根节点：`toolbar` → 书签栏（`1`），`other` → 其他书签（`2`），`mobile` → 移动设备书签（根 `3`，不存在则跳过该项并计入失败）；
  2. 按 `path` 逐级在目标根下查找同名文件夹，不存在则 `chrome.bookmarks.create({parentId, title})`；
  3. 在末级文件夹内 `chrome.bookmarks.create({parentId, title, url})`；
  4. 逐项容错，返回创建数与失败列表。

## 12. UI 规格（app.html）

### 12.1 布局

- **顶栏**：插件名、「扫描全部」按钮、扫描中进度条（`已完成/总数`、当前 URL）、「取消」按钮；统计徽章：可用、失效、可疑、跳过。
- **左侧栏**：书签树。文件夹带三态复选框（选中/未选/半选）；根节点可整体勾选；顶部「全选 / 清空」按钮；底部显示「已选 N 个链接」与「扫描所选」按钮。
- **右侧主区**：
  - 筛选标签：全部 / 失效 / 可疑 / 可用 / 跳过（显示计数）；
  - 结果列表：每行标题、URL（截断显示，hover 全量）、状态徽章、HTTP 码、操作（打开、删除）；重定向时显示最终 URL；
  - 批量栏：「一键清理失效（N）」，仅作用于确认失效项。
- **底部**：「备份记录」入口，展开显示备份列表（时间、条数、下载、恢复）。

### 12.2 交互状态

- 扫描中：禁用「扫描全部 / 扫描所选」，显示进度与取消；已完成项实时进入列表。
- 重开页面：有 `lastScan` 快照则直接展示结果与「上次扫描于…」；running 状态显示「扫描进行中」并重新接入进度。
- 删除/清理/恢复均用页内自定义弹窗，不使用原生 `confirm`。
- 空态：无书签、无结果、无备份分别给出简明提示。
- 样式：原生 CSS，卡片式布局，深色模式经 `prefers-color-scheme` 适配；全中文文案。

## 13. 错误处理与边界

| 情形 | 处理 |
|---|---|
| `chrome.bookmarks` 不可用（权限缺失） | 页面显式报错，禁用扫描 |
| 扫描中 service worker 意外重启 | 快照为 running 且无活动任务时，打开页面提示「上次扫描中断」，展示已完成结果并提供重新扫描 |
| 同 URL 多书签 | 单次探测，结果共享 |
| 非 http(s) 书签 | 判 `skipped`，不计入清理范围 |
| 删除时书签已不存在 | 视为成功 |
| `storage.local` 写入失败 | 备份失败则中止清理；快照写入失败仅告警 |
| 用户关闭 UI | 扫描继续；端口断开不影响后台任务 |
| 超长 URL / 特殊字符 | 原样展示与传输，不做编码改写 |

## 14. 测试计划

### 14.1 单元测试（`node --test`）

- `verdict.test.js`：`isCheckable` 各协议；`classify` 覆盖全部状态码分支（2xx、3xx、401、403、404、410、429、其他 4xx、5xx、超时、网络错误、无状态）。
- `scanner.test.js`（注入 fetch stub）：
  - HEAD 成功不回退 GET；
  - HEAD 404 → GET 200 判 ok；
  - HEAD 403 → GET 403 判 suspicious；
  - HEAD 超时不复核；
  - 同 URL 去重共享结果；
  - 并发池同时请求数不超过 8；
  - 取消后不产生新请求。
- `backup.test.js`：备份结构与计数；最多保留 10 份的轮转；`buildRestorePlan` 对已存在/不存在文件夹的分支；mobile 根缺失的失败处理。

### 14.2 手工验收（加载 unpacked 于 Chrome）

1. 打开扩展页，书签树正确显示，多选父节点出现半选态；
2. 扫描真实书签：正常页判可用、404 页判失效、需登录页判可疑、`chrome://` 判跳过，进度实时更新；
3. 关闭 UI 后扫描继续，重开可恢复结果；
4. 单项删除后书签管理器中消失；
5. 一键清理：先触发备份下载并存于备份记录，再删除全部失效项，统计正确；
6. 从备份恢复后，书签回到原有根与路径；
7. 取消扫描后进度停止，已测结果保留。

## 15. 验收标准

- 上述手工验收 1–7 全部通过；
- 单元测试全部通过；
- 清理流程在无备份时绝不删除书签；
- 可疑项不被一键清理波及；
- UI 关闭/重开不丢失已完成结果。
