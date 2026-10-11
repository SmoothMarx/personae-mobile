/**
 * Generic storage seam: expo-secure-store on device, an in-memory map everywhere else.
 *
 * The fallback matters for one reason beyond tests: a SecureStore failure (locked keystore, a
 * simulator without one) must not silently drop what the user typed — it degrades to memory and
 * the Settings screen still shows the effective value for this run.
 */

type Store = {
  getItemAsync: (key: string) => Promise<string | null>;
  setItemAsync: (key: string, value: string) => Promise<void>;
  deleteItemAsync: (key: string) => Promise<void>;
};

const memory = new Map<string, string>();
let nativeStore: Store | null = null;
let probed = false;

function getNativeStore(): Store | null {
  if (probed) return nativeStore;
  probed = true;
  try {
    // Loaded lazily and guarded: SecureStore throws when the native module is absent.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('expo-secure-store') as Store & { isAvailableAsync?: () => Promise<boolean> };
    if (mod && typeof mod.getItemAsync === 'function') nativeStore = mod;
  } catch {
    nativeStore = null;
  }
  return nativeStore;
}

export async function storeGet(key: string): Promise<string | null> {
  const native = getNativeStore();
  if (native) {
    try {
      const value = await native.getItemAsync(key);
      if (value !== null && value !== undefined) return value;
    } catch {
      /* fall through to memory */
    }
  }
  return memory.has(key) ? (memory.get(key) as string) : null;
}

export async function storeSet(key: string, value: string): Promise<void> {
  memory.set(key, value);
  const native = getNativeStore();
  if (native) {
    try {
      await native.setItemAsync(key, value);
    } catch {
      /* memory copy already holds it for this session */
    }
  }
}

export async function storeDelete(key: string): Promise<void> {
  memory.delete(key);
  const native = getNativeStore();
  if (native) {
    try {
      await native.deleteItemAsync(key);
    } catch {
      /* nothing else to do */
    }
  }
}

/** Test seam: forget the cached native store probe. */
export function __resetStoreProbe(): void {
  nativeStore = null;
  probed = false;
  memory.clear();
}
