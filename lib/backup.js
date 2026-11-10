export const MAX_BACKUPS = 10;

const ROOT_IDS = { toolbar: '1', other: '2', mobile: '3' };

export function buildBackup(items, { id, now = Date.now(), reason = 'cleanup' } = {}) {
  return {
    id: id ?? `bk_${now}`,
    version: 1,
    createdAt: now,
    reason,
    count: items.length,
    // 复制路径数组，避免备份快照与后续扫描结果共享引用而被改动。
    items: items.map(({ title, url, rootKind, path }) => ({
      title,
      url,
      rootKind,
      path: [...path],
    })),
  };
}

export function trimBackups(backups, max = MAX_BACKUPS) {
  // 恢复时默认取最新一份，故按 createdAt 降序并只留最近 max 份。
  return [...backups].sort((a, b) => b.createdAt - a.createdAt).slice(0, max);
}

export function buildRestorePlan(backup, tree) {
  const rootChildren = tree[0]?.children ?? [];
  const rootById = new Map(rootChildren.map((node) => [node.id, node]));

  return backup.items.map((item) => {
    const rootId = ROOT_IDS[item.rootKind] ?? null;
    const rootNode = rootId ? rootById.get(rootId) : null;
    // 移动端书签根 '3' 只在部分平台存在，缺失时交由调用方提示或跳过。
    if (!rootNode) {
      return { item, rootId: null, folders: [], missingRoot: true };
    }

    const folders = [];
    let parentNode = rootNode;
    for (const title of item.path.filter(Boolean)) {
      const found = parentNode
        ? (parentNode.children ?? []).find((child) => !child.url && child.title === title)
        : null;
      // 上级文件夹需新建则后代在树中必然不存在，existingId 一律为 null。
      folders.push({ title, existingId: found ? found.id : null });
      parentNode = found ?? null;
    }
    return { item, rootId, folders, missingRoot: false };
  });
}
