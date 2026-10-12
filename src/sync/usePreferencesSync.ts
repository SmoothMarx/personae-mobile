/**
 * React glue for portable-preference sync (0.9.0 Phase I): one instance per phone, live for as long
 * as the app is configured.
 *
 * It never blocks anything. A failure leaves the phone exactly where 0.8.0 was — local-only — and the
 * only thing it changes is a status word the Settings page can show.
 *
 * THE LOOP GUARD MATTERS. Applying a server value is a local change, which would otherwise look like
 * an edit worth pushing, which would bump the revision, which would make the desktop think something
 * new happened. So the hook remembers the last snapshot it either PUSHED or APPLIED, and pushes only
 * a genuine difference from it (the same `changedKeys` diff the local writer uses).
 */
import { useEffect, useRef, useState } from 'react';

import type { PreferenceDocument } from '../api/dashboard';
import type { Backend } from '../api/backend';
import type { RosterPrefs } from '../rosterPrefs';
import type { Settings } from '../settings';
import type { SectionsModel } from '../logic/sections';
import {
  applyPortable,
  changedKeys,
  patchFor,
  readPortable,
  type PortableKey,
  type PreferenceRevision,
} from './preferences';

export type PreferenceSyncStatus = 'idle' | 'unsupported' | 'synced' | 'offline';

export function usePreferencesSync(opts: {
  /** Off on the legacy surface and before the app is configured — the document is a dashboard route. */
  enabled: boolean;
  backend: Backend;
  settingsReady: boolean;
  settings: Settings;
  sections: SectionsModel;
  /** Write a portable change back into the settings store. */
  applySettings: (patch: Partial<Settings>) => void;
  /** …and a roster-sections change. */
  applySections: (next: SectionsModel) => void;
}): PreferenceSyncStatus {
  const [status, setStatus] = useState<PreferenceSyncStatus>('idle');
  const revision = useRef<PreferenceRevision>(0);
  const lastSeen = useRef<Record<PortableKey, unknown> | null>(null);
  const started = useRef(false);

  const snapshot = readPortable(opts.settings, opts.sections);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const write = useRef(opts.applySettings);
  write.current = opts.applySettings;
  const writeSections = useRef(opts.applySections);
  writeSections.current = opts.applySections;

  // ── the pull: once, on the first configuration of this session ──
  useEffect(() => {
    if (!opts.enabled || !opts.settingsReady || started.current) return;
    started.current = true;
    let alive = true;
    void (async () => {
      try {
        const document: PreferenceDocument | null = await opts.backend.preferences();
        if (!alive) return;
        if (!document) {
          setStatus('unsupported');
          return;
        }
        revision.current = document.revision;
        const result = applyPortable(opts.settings, opts.sections, document);
        if (result.settings !== opts.settings) write.current(result.settings);
        if (result.sections !== opts.sections) writeSections.current(result.sections);
        // Record what the server's document says, so the push below does NOT immediately echo it.
        lastSeen.current = readPortable(result.settings, result.sections);
        setStatus('synced');
      } catch {
        setStatus('offline');
      }
    })();
    return () => {
      alive = false;
    };
  }, [opts.backend, opts.enabled, opts.sections, opts.settings, opts.settingsReady]);

  // ── the push: only a genuine local difference, and never before the pull has settled ──
  useEffect(() => {
    if (!opts.enabled || !opts.settingsReady || !lastSeen.current) return;
    const before = lastSeen.current;
    const changed = changedKeys(before, snapshot);
    if (!changed.length) return;
    lastSeen.current = snapshot;
    void (async () => {
      try {
        let document = await opts.backend.putPreferences(patchFor(changed[0], snapshot[changed[0]], revision.current));
        // One key per patch would be several round trips; the remaining keys ride a second merge.
        for (const key of changed.slice(1)) {
          document = await opts.backend.putPreferences(patchFor(key, snapshot[key], revision.current));
        }
        if (!document) {
          lastSeen.current = before;
          setStatus('unsupported');
          return;
        }
        revision.current = document.revision;
        setStatus('synced');
      } catch {
        lastSeen.current = before;
        setStatus('offline');
      }
    })();
  }, [opts.backend, opts.enabled, opts.settingsReady, snapshot]);

  return status;
}

/** Read out of the roster prefs, so a caller does not need to know the shape of either store. */
export function portableSnapshot(prefs: RosterPrefs, settings: Settings): {
  settings: Settings;
  sections: SectionsModel;
} {
  void prefs;
  return { settings, sections: prefs.sections };
}
