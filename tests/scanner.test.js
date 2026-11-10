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
