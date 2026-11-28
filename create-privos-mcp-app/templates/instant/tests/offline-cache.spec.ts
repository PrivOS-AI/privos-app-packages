import type { AppStorage } from '@privos_ai/app-react';
import { describe, expect, it } from 'vitest';

import { cacheKey, clearCache, readCache, writeCache } from '../src/ui/offline-cache';

function memoryStorage(): AppStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => {
      values.set(key, value);
    },
    remove: async (key) => {
      values.delete(key);
    },
  };
}

const failing: AppStorage = {
  get: async () => {
    throw new Error('storage unavailable');
  },
  set: async () => {
    throw new Error('quota exceeded');
  },
  remove: async () => {
    throw new Error('storage unavailable');
  },
};

describe('offline cache', () => {
  it('keys every copy by user and room', () => {
    expect(cacheKey('u1', 'r1', 'lists')).not.toBe(cacheKey('u2', 'r1', 'lists'));
    expect(cacheKey('u1', 'r1', 'lists')).not.toBe(cacheKey('u1', 'r2', 'lists'));
  });

  it('returns what was saved, with the time it was read', async () => {
    const storage = memoryStorage();
    await writeCache(storage, 'k', [{ _id: '1', name: 'Tasks' }], '2026-11-28T00:00:00.000Z');
    expect(await readCache(storage, 'k')).toEqual({ savedAt: '2026-11-28T00:00:00.000Z', value: [{ _id: '1', name: 'Tasks' }] });
    await clearCache(storage, 'k');
    expect(await readCache(storage, 'k')).toBeUndefined();
  });

  it('treats a missing, broken or foreign entry as no copy', async () => {
    const storage = memoryStorage();
    expect(await readCache(storage, 'missing')).toBeUndefined();
    storage.values.set('broken', '{not json');
    expect(await readCache(storage, 'broken')).toBeUndefined();
    storage.values.set('foreign', JSON.stringify({ value: 1 }));
    expect(await readCache(storage, 'foreign')).toBeUndefined();
  });

  it('never throws when the storage fails', async () => {
    await expect(writeCache(failing, 'k', 1)).resolves.toBeUndefined();
    await expect(readCache(failing, 'k')).resolves.toBeUndefined();
    await expect(clearCache(failing, 'k')).resolves.toBeUndefined();
  });
});
