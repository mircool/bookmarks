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
