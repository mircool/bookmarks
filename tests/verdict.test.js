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
