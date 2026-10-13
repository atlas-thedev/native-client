const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('server settings refresh preserves unrelated unsaved drafts and accepts saved fields', async () => {
  const { mergeAdminDraft } = await import('../src/features/admin/adminState.mjs');
  const previous = { enabled: false, message: 'Before', until: null };
  const draft = { ...previous, message: 'Unsaved text' };
  assert.strictEqual(mergeAdminDraft(draft, previous, { ...previous }), draft);
  assert.deepEqual(mergeAdminDraft(draft, previous, { ...previous, enabled: true }), { ...draft, enabled: true });
  assert.deepEqual(mergeAdminDraft(draft, previous, { ...draft }), draft);
  assert.deepEqual(mergeAdminDraft(previous, previous, { ...previous, enabled: true }), { ...previous, enabled: true });
  assert.deepEqual(mergeAdminDraft(null, undefined, previous), previous);
  const launch = { at: 123, founderCapes: ['a'] };
  assert.deepEqual(mergeAdminDraft({ ...launch, founderCapes: ['a', 'b'] }, launch, { ...launch, at: 456 }), { at: 456, founderCapes: ['a', 'b'] });
});

test('shared admin action guard prevents overlapping writes and releases after failures', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-state-'));
  try {
    // Exercise the hook's asynchronous guard with deterministic hook primitives.
    const mock = path.join(work, 'react.cjs');
    fs.writeFileSync(mock, `module.exports = { ...require(${JSON.stringify(require.resolve('react'))}), useRef: value => ({ current: value }), useState: () => ['', value => globalThis.__states.push(value)], useCallback: fn => fn };`);
    const outfile = path.join(work, 'shared.cjs');
    require('esbuild').buildSync({
      entryPoints: [path.join(__dirname, '../src/features/admin/adminShared.jsx')], outfile,
      bundle: true, platform: 'node', format: 'cjs', loader: { '.css': 'empty' },
      alias: { react: mock }, logLevel: 'error'
    });
    globalThis.__states = [];
    const { useAdminAction, adminError } = require(outfile);
    let resolve, calls = 0, notifications = 0, revoked = 0;
    const { run } = useAdminAction(() => notifications++);
    const first = run('first', () => { calls++; return new Promise(r => { resolve = r; }); }, 'Saved');
    const duplicate = await run('second', () => { calls++; }, 'Saved');
    assert.equal(duplicate, undefined);
    assert.equal(calls, 1);
    resolve('done');
    assert.equal(await first, 'done');
    assert.equal(notifications, 1);
    await run('failure', () => { throw new Error('Validation required'); });
    assert.ok(globalThis.__states.includes('Validation required'));
    assert.equal(await run('retry', async () => 'recovered'), 'recovered');
    adminError({ error: 'Title required.' }, 'Fallback', () => revoked++);
    assert.equal(revoked, 0, 'validation errors must not kick admins out');
    adminError({ error: 'Administrator access required.' }, 'Fallback', () => revoked++);
    adminError({ status: 401, error: 'Expired' }, 'Fallback', () => revoked++);
    assert.equal(revoked, 2);
  } finally {
    delete globalThis.__states;
    fs.rmSync(work, { recursive: true, force: true });
  }
});
