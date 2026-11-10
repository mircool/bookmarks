// 从 Chrome 书签树按所选文件夹收集书签，并按严重程度对结果排序。
// Chrome 书签根节点 ID 固定为 1/2/3，分别对应书签栏、其他书签、移动端书签。
export const ROOT_KIND_BY_ID = { '1': 'toolbar', '2': 'other', '3': 'mobile' };

const VERDICT_RANK = { broken: 0, suspicious: 1, ok: 2, skipped: 3 };

export function collectBookmarks(tree, selectedIds) {
  const selected = new Set(selectedIds);
  // seen 防御树中重复出现的同一节点，保证一个书签只收一次。
  const seen = new Set();
  const items = [];

  const visit = (node, rootKind, path, active) => {
    // 根节点（隐藏根 '0' 与三个固定根）不进 folderPath，路径只记录用户可见文件夹。
    const isRootNode = node.id === '0' || ROOT_KIND_BY_ID[node.id] !== undefined;
    const nextRootKind = ROOT_KIND_BY_ID[node.id] ?? rootKind;

    if (node.url) {
      // 非 http(s) 书签照样收集，由探测阶段统一标为 skipped。
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

    // 选中文件夹即代表其整棵子树都要检查。
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
  // 先按严重度排名，同等级保持原顺序（未知判定值排末尾）。
  return results
    .map((result, index) => ({ result, index }))
    .sort((a, b) => {
      const rankDiff = (VERDICT_RANK[a.result.verdict] ?? 9) - (VERDICT_RANK[b.result.verdict] ?? 9);
      return rankDiff !== 0 ? rankDiff : a.index - b.index;
    })
    .map((entry) => entry.result);
}
