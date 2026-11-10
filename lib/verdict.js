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
