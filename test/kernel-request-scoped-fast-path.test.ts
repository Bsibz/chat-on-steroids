import { expect, it } from 'vitest';
import { safelyRequestScopedRead } from '../src/main/mcp/kernel.js';

it('permits only explicit absolute Core reads on the unattributed request-scoped fast path', () => {
  expect(safelyRequestScopedRead('read', { paths: ['/workspace/a.ts', '/workspace/b.ts'] }, 'core', true)).toBe(true);
  expect(safelyRequestScopedRead('view_image', { path: '/workspace/a.png' }, 'core', true)).toBe(true);
  expect(safelyRequestScopedRead('find', { query: 'needle', path: '/workspace/src' }, 'core', true)).toBe(true);

  expect(safelyRequestScopedRead('read', { paths: ['src/a.ts'] }, 'core', true)).toBe(false);
  expect(safelyRequestScopedRead('find', { query: 'needle' }, 'core', true)).toBe(false);
  expect(safelyRequestScopedRead('exec_command', { cmd: 'echo x', workdir: '/workspace' }, 'core', true)).toBe(false);
  expect(safelyRequestScopedRead('apply_patch', { patch: 'x' }, 'core', true)).toBe(false);
  expect(safelyRequestScopedRead('update_plan', { plan: [] }, 'core', true)).toBe(false);
  expect(safelyRequestScopedRead('agents', { action: 'status' }, 'core', true)).toBe(false);
  expect(safelyRequestScopedRead('read', { paths: ['/workspace/a.ts'] }, 'desktop', true)).toBe(false);
  expect(safelyRequestScopedRead('read', { paths: ['/workspace/a.ts'] }, 'core', false)).toBe(false);
});
