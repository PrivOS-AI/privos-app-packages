/**
 * Offline-first reads: show the copy this browser saved last, at once, then
 * refresh it from the workspace in the background and save the new copy.
 *
 * The copy lives in `app.storage`, the host's localStorage under a per-app
 * namespace. The app document runs in an opaque origin, so its own
 * localStorage and IndexedDB are not available. That storage is per browser
 * profile, shared by the whole workspace page (a few MB in total) and kept
 * after a logout, so:
 *  - every key names the user and the room (`cacheKey`), so one person's copy
 *    never appears for another;
 *  - store only what the screen shows, and nothing you would not leave on a
 *    shared computer (no tokens, salaries or other personal data);
 *  - a copy is a display hint, never an authority: the Hub decides on every read.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppStorage } from '@privos_ai/app-react';

/** Bump when the shape of a stored value changes; older copies are then ignored. */
const CACHE_VERSION = 'v1';

export interface CacheEntry<T> {
  savedAt: string;
  value: T;
}

export function cacheKey(userId: string, roomId: string, name: string): string {
  return `${CACHE_VERSION}:${userId}:${roomId}:${name}`;
}

/** The saved copy, or undefined when there is none or it cannot be read. */
export async function readCache<T>(storage: AppStorage, key: string): Promise<CacheEntry<T> | undefined> {
  try {
    const raw = await storage.get(key);
    if (!raw) return undefined;
    const entry = JSON.parse(raw) as Partial<CacheEntry<T>> | null;
    return entry && typeof entry.savedAt === 'string' && 'value' in entry ? (entry as CacheEntry<T>) : undefined;
  } catch {
    return undefined;
  }
}

/** Best effort: a full or unavailable storage must never break the screen. */
export async function writeCache<T>(storage: AppStorage, key: string, value: T, savedAt = new Date().toISOString()): Promise<void> {
  try {
    await storage.set(key, JSON.stringify({ savedAt, value } satisfies CacheEntry<T>));
  } catch {
    // The fresh value is already on screen; only the next open loses its head start.
  }
}

export async function clearCache(storage: AppStorage, key: string): Promise<void> {
  try {
    await storage.remove(key);
  } catch {
    // Nothing to do: an entry that cannot be removed is also never shown without a key.
  }
}

export interface CachedRead<T> {
  /** The saved copy first, then the fresh value. */
  data?: T;
  /** When `data` was read from the workspace. */
  savedAt?: string;
  refreshing: boolean;
  /** The last refresh failed; `data`, if any, is the older copy. */
  error?: Error;
  refresh(): void;
}

interface CachedReadState<T> {
  key?: string;
  data?: T;
  savedAt?: string;
  refreshing: boolean;
  error?: Error;
}

/**
 * `key` undefined means there is nothing to show yet (no user or room, or no access).
 * `enabled` false shows the saved copy without asking the workspace, for example
 * while an access check is still running.
 */
export function useCachedRead<T>(storage: AppStorage, key: string | undefined, load: () => Promise<T>, enabled = true): CachedRead<T> {
  const [state, setState] = useState<CachedReadState<T>>({ refreshing: false });
  const [attempt, setAttempt] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!key) {
      setState({ refreshing: false });
      return;
    }
    let cancelled = false;
    let fresh = false;
    // Another key is another copy: never show the previous one under it.
    setState((current) => (current.key === key ? current : { key, refreshing: false }));
    void readCache<T>(storage, key).then((entry) => {
      if (cancelled || fresh || !entry) return;
      setState((current) => (current.key === key && current.data === undefined ? { ...current, data: entry.value, savedAt: entry.savedAt } : current));
    });
    if (!enabled) {
      setState((current) => (current.refreshing ? { ...current, refreshing: false } : current));
      return () => {
        cancelled = true;
      };
    }
    setState((current) => ({ ...current, key, refreshing: true, error: undefined }));
    // Through a promise, so a loader that throws before returning one lands in `error` too.
    Promise.resolve().then(() => loadRef.current()).then(
      (value) => {
        if (cancelled) return;
        fresh = true;
        const savedAt = new Date().toISOString();
        setState({ key, data: value, savedAt, refreshing: false });
        void writeCache(storage, key, value, savedAt);
      },
      (reason: unknown) => {
        if (cancelled) return;
        setState((current) => ({ ...current, refreshing: false, error: reason instanceof Error ? reason : new Error(String(reason)) }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [storage, key, enabled, attempt]);

  const refresh = useCallback(() => setAttempt((value) => value + 1), []);
  return { data: state.data, savedAt: state.savedAt, refreshing: state.refreshing, error: state.error, refresh };
}
