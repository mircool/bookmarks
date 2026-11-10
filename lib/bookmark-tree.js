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
