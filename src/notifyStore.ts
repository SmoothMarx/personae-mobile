/**
 * The notified-checkpoint watermark (0.8.0 H) — `personae.notify.v1`, in AsyncStorage.
 *
 * Dedupe needs to survive a restart, otherwise every relaunch re-announces the same checkpoint. The
 * map is `(sessionId, kind, last_active) -> when`, capped and pruned by age in
 * `src/logic/checkpoints.ts` (tested there); this module is only the read and the write, and it
 * degrades to memory rather than throwing when the store is unavailable.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import { pruneWatermark, type Watermark } from './logic/checkpoints';

export const NOTIFY_STORE_KEY = 'personae.notify.v1';

export type WatermarkStore = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

/** Used when AsyncStorage is missing (a test host, or a broken native module). */
let memory: Watermark = {};

function defaultStore(): WatermarkStore | null {
  try {
    return AsyncStorage as unknown as WatermarkStore;
  } catch {
    return null;
  }
}

export async function loadWatermark(store: WatermarkStore | null = defaultStore()): Promise<Watermark> {
  if (!store) return memory;
  try {
    const blob = await store.getItem(NOTIFY_STORE_KEY);
    if (!blob) return memory;
    const parsed = JSON.parse(blob);
    if (!parsed || typeof parsed !== 'object') return memory;
    const out: Watermark = {};
    for (const [key, at] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof at === 'number' && Number.isFinite(at)) out[key] = at;
    }
    memory = out;
    return out;
  } catch {
    return memory;
  }
}

export async function saveWatermark(map: Watermark, store: WatermarkStore | null = defaultStore()): Promise<void> {
  const capped = pruneWatermark(map);
  memory = capped;
  if (!store) return;
  try {
    await store.setItem(NOTIFY_STORE_KEY, JSON.stringify(capped));
  } catch {
    /* the in-memory copy still holds it for this run */
  }
}
