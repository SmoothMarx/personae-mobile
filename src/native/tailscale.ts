/**
 * JS bridge to the local Android module `tailscale-trigger` (TailscaleTriggerModule.kt).
 *
 * Loaded OPTIONALLY and lazily, the same way `src/storage.ts` loads expo-secure-store: the module
 * does not exist on iOS, in Expo Go, or under the Node test runner, and its absence must degrade to
 * "this capability is unavailable here" rather than crash the app. Every function below therefore
 * has a safe answer when the native side is missing.
 *
 * The capability is Android-only, and that is not a bug to be worked around: iOS has no cross-app
 * broadcast, so no iOS app can bring another app's tunnel up. The honest iOS path is Tailscale's own
 * on-demand setting, enabled once by the user, plus this app explaining the state.
 */

export type TriggerResult = { installed: boolean; sent: boolean };

type RawTailscaleTrigger = {
  isPackageInstalled: (pkg: string) => Promise<boolean>;
  triggerConnect: (pkg: string) => Promise<TriggerResult>;
  triggerDisconnect: (pkg: string) => Promise<TriggerResult>;
  openApp: (pkg: string) => Promise<boolean>;
  vpnTransportActive: () => Promise<boolean>;
  probeTcp: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
};

let cached: RawTailscaleTrigger | null | undefined;

function loadModule(): RawTailscaleTrigger | null {
  if (cached !== undefined) return cached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const core = require('expo-modules-core') as {
      requireOptionalNativeModule?: (name: string) => unknown;
    };
    const mod = typeof core.requireOptionalNativeModule === 'function'
      ? core.requireOptionalNativeModule('TailscaleTrigger')
      : null;
    cached = (mod as RawTailscaleTrigger | null) ?? null;
  } catch {
    cached = null;
  }
  return cached;
}

/** Test seam, mirroring `__resetStoreProbe` in src/storage.ts. */
export function __resetTriggerProbe(): void {
  cached = undefined;
}

/** True when the Android native module is present in this build/runtime. */
export function triggerAvailable(): boolean {
  return loadModule() !== null;
}

/** False on iOS, in Expo Go, and in tests — never an error. */
export async function isPackageInstalled(pkg: string): Promise<boolean> {
  const mod = loadModule();
  if (!mod || !pkg.trim()) return false;
  try {
    return await mod.isPackageInstalled(pkg.trim());
  } catch {
    return false;
  }
}

/**
 * Ask the Tailscale client to bring its tunnel up.
 *
 * `sent: true` means only that an explicit intent was handed to the OS — the broadcast is
 * fire-and-forget and reports nothing back, so the caller must prove readiness by probing.
 */
export async function triggerTailscaleConnect(pkg: string): Promise<TriggerResult> {
  const mod = loadModule();
  if (!mod || !pkg.trim()) return { installed: false, sent: false };
  try {
    return await mod.triggerConnect(pkg.trim());
  } catch {
    return { installed: false, sent: false };
  }
}

export async function triggerTailscaleDisconnect(pkg: string): Promise<TriggerResult> {
  const mod = loadModule();
  if (!mod || !pkg.trim()) return { installed: false, sent: false };
  try {
    return await mod.triggerDisconnect(pkg.trim());
  } catch {
    return { installed: false, sent: false };
  }
}

/** Fallback UX for the one-time setup step that no app can do for the user. */
export async function openPackage(pkg: string): Promise<boolean> {
  const mod = loadModule();
  if (!mod || !pkg.trim()) return false;
  try {
    return await mod.openApp(pkg.trim());
  } catch {
    return false;
  }
}

/**
 * Disk-cheap hint for the diagnostics panel ONLY. A competing VPN makes this true while Tailscale
 * is disconnected, so it is never a readiness test — that is what `probeTcp` is for.
 */
export async function vpnTransportActive(): Promise<boolean> {
  const mod = loadModule();
  if (!mod) return false;
  try {
    return await mod.vpnTransportActive();
  } catch {
    return false;
  }
}

/**
 * A real TCP connect with a real timeout. On a non-Android runtime there is no socket primitive
 * exposed here, so the answer is `false` — which the engine treats as "not reachable yet".
 */
export async function probeTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const mod = loadModule();
  if (!mod) return false;
  try {
    return await mod.probeTcp(host, port, timeoutMs);
  } catch {
    return false;
  }
}
