// 链接状态判定：把一次探测归为 ok / broken / suspicious / skipped 四档。
export const VERDICT = {
  OK: 'ok',
  BROKEN: 'broken',
  SUSPICIOUS: 'suspicious',
  SKIPPED: 'skipped',
};

export function isCheckable(url) {
  try {
    const parsed = new URL(url);
    // 仅 http(s) 可探测：chrome://、file: 等协议无法发起网络请求，由调用方跳过。
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function classify({ httpStatus = null, error = null } = {}) {
  // 超时或网络错误时连响应都没拿到，无从评级，保守判 broken。
  if (error === 'timeout' || error === 'network') return VERDICT.BROKEN;
  // 缺状态码说明探测未完成，宁可误报坏也不误报好。
  if (!Number.isInteger(httpStatus)) return VERDICT.BROKEN;
  if (httpStatus >= 200 && httpStatus < 400) return VERDICT.OK;
  // 404/410 语义明确：资源已不存在。
  if (httpStatus === 404 || httpStatus === 410) return VERDICT.BROKEN;
  if (httpStatus >= 500 && httpStatus < 600) return VERDICT.BROKEN;
  // 其余 4xx（401/403/407/429）多为反爬、登录墙或限流，链接未必失效，只标可疑。
  return VERDICT.SUSPICIOUS;
}
