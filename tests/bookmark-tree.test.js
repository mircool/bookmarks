import test from 'node:test';
import assert from 'node:assert/strict';
import { collectBookmarks, sortResults, ROOT_KIND_BY_ID } from '../lib/bookmark-tree.js';

const tree = [{
  id: '0',
  title: '',
  children: [
    {
      id: '1',
      title: '书签栏',
      children: [
        {
          id: '10',
          title: 'A',
          children: [
            { id: '100', title: 'a1', url: 'https://a1.example' },
            { id: '101', title: 'a2', url: 'chrome://settings' },
          ],
        },
        { id: '11', title: 'b1', url: 'https://b1.example' },
      ],
    },
    { id: '2', title: '其他书签', children: [] },
    { id: '3', title: '移动设备书签', children: [] },
  ],
}];

test('根节点 ID 映射正确', () => {
  assert.deepEqual(ROOT_KIND_BY_ID, { '1': 'toolbar', '2': 'other', '3': 'mobile' });
});

test('传 [0] 收集全部书签（含非 http(s)）', () => {
  const items = collectBookmarks(tree, ['0']);
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((i) => i.url), [
    'https://a1.example',
    'chrome://settings',
    'https://b1.example',
  ]);
});

test('选中文件夹只收其子树，路径与根类型正确', () => {
  const items = collectBookmarks(tree, ['10']);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0].folderPath, ['A']);
  assert.equal(items[0].rootKind, 'toolbar');
  assert.equal(items[0].bookmarkId, '100');
});

test('选中根节点收集整根', () => {
  assert.equal(collectBookmarks(tree, ['1']).length, 3);
  assert.equal(collectBookmarks(tree, ['2']).length, 0);
});

test('父子同时选中不产生重复', () => {
  assert.equal(collectBookmarks(tree, ['1', '10']).length, 3);
});

test('sortResults 按失效、可疑、可用、跳过排序且同档稳定', () => {
  const results = [
    { bookmarkId: '1', verdict: 'ok' },
    { bookmarkId: '2', verdict: 'broken' },
    { bookmarkId: '3', verdict: 'skipped' },
    { bookmarkId: '4', verdict: 'suspicious' },
    { bookmarkId: '5', verdict: 'broken' },
  ];
  assert.deepEqual(sortResults(results).map((r) => r.bookmarkId), ['2', '5', '4', '1', '3']);
});
