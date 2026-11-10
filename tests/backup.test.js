import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_BACKUPS, buildBackup, trimBackups, buildRestorePlan } from '../lib/backup.js';

test('buildBackup 抽取字段并计数', () => {
  const items = [
    { bookmarkId: '1', title: '旧站', url: 'https://old.example', rootKind: 'toolbar', folderPath: ['技术', '前端'], verdict: 'broken' },
  ];
  const backup = buildBackup(items, { id: 'bk_1', now: 1000 });
  assert.equal(backup.id, 'bk_1');
  assert.equal(backup.version, 1);
  assert.equal(backup.createdAt, 1000);
  assert.equal(backup.reason, 'cleanup');
  assert.equal(backup.count, 1);
  assert.deepEqual(backup.items, [
    { title: '旧站', url: 'https://old.example', rootKind: 'toolbar', path: ['技术', '前端'] },
  ]);
});

test('trimBackups 保留最新 10 份', () => {
  const list = Array.from({ length: 12 }, (_, i) => ({ id: `bk_${i}`, createdAt: i }));
  const trimmed = trimBackups(list);
  assert.equal(trimmed.length, MAX_BACKUPS);
  assert.equal(trimmed[0].id, 'bk_11');
  assert.equal(trimmed[9].id, 'bk_2');
});

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
          title: '技术',
          children: [{ id: '11', title: '前端', children: [] }],
        },
      ],
    },
    { id: '2', title: '其他书签', children: [] },
  ],
}];

test('buildRestorePlan 解析已存在与需新建的文件夹', () => {
  const backup = {
    items: [
      { title: 'X', url: 'https://x.example', rootKind: 'toolbar', path: ['技术', '前端'] },
      { title: 'Y', url: 'https://y.example', rootKind: 'toolbar', path: ['技术', '新目录', '深层'] },
      { title: 'Z', url: 'https://z.example', rootKind: 'mobile', path: [] },
    ],
  };
  const plan = buildRestorePlan(backup, tree);
  assert.equal(plan.length, 3);

  assert.equal(plan[0].rootId, '1');
  assert.equal(plan[0].missingRoot, false);
  assert.deepEqual(plan[0].folders, [
    { title: '技术', existingId: '10' },
    { title: '前端', existingId: '11' },
  ]);

  assert.equal(plan[1].folders[0].existingId, '10');
  assert.equal(plan[1].folders[1].existingId, null);
  assert.equal(plan[1].folders[2].existingId, null);

  assert.equal(plan[2].missingRoot, true);
  assert.equal(plan[2].rootId, null);
});

test('buildRestorePlan 对空路径直接落在根下', () => {
  const backup = {
    items: [{ title: 'R', url: 'https://r.example', rootKind: 'other', path: [] }],
  };
  const plan = buildRestorePlan(backup, tree);
  assert.equal(plan[0].rootId, '2');
  assert.deepEqual(plan[0].folders, []);
  assert.equal(plan[0].missingRoot, false);
});
