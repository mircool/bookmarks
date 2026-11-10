// 链接探测：HEAD 优先、失败转 GET 复核，带超时与有界并发。
import { isCheckable, classify } from './verdict.js';

export const DEFAULT_TIMEOUT_MS = 15000;
export const DEFAULT_CONCURRENCY = 8;

async function request(url, method, fetchImpl, timeoutMs, outerSignal) {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (outerSignal) signals.push(outerSignal);
  // 单次超时与外部取消任一触发即中止，故合并两个信号。
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

  let response;
  try {
    response = await fetchImpl(url, { method, redirect: 'follow', signal });
  } catch (err) {
    // 外部取消是调用方意图，须原样上抛，不能记成网络失败。
    if (outerSignal?.aborted) throw err;
    // fetch 超时抛 TimeoutError，其余错误统一归为 network。
    if (err?.name === 'TimeoutError') return { error: 'timeout' };
    return { error: 'network' };
  }

  // 只关心状态码，主动取消响应体，免得继续下载白占连接。
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
  // HEAD 超时不回退 GET：再等一轮只会让总耗时翻倍。
  if (head.error === 'timeout') {
    return { verdict: 'broken', httpStatus: null, finalUrl: null, error: 'timeout' };
  }

  // HEAD 失败多为站点不支持该方法（405/501），用 GET 复核以免误判。
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
  // 缓存的是 Promise 而非结果，同 URL 并发时共享同一次探测。
  const cache = new Map();
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      // 已取消则直接退出，不为未处理项补记失败。
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
        // 取消引发的拒绝同样退出，不记为失败。
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
      // 按原始下标回填，顺序与输入一致；取消留下的空位由末尾 filter 清掉。
      slots[index] = result;
      onResult(result);
    }
  };

  const workerCount = Math.min(concurrency, Math.max(items.length, 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return slots.filter(Boolean);
}
