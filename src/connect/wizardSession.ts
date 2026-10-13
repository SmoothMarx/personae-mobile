/**
 * The wizard's own state: has it been dismissed, and where was the user (0.10.0 S3 entry).
 *
 * Three of the four entry rules live here:
 *
 *   (a) **On first launch with no configured connection, the wizard opens by itself.** "No configured
 *       connection" is `settings.baseUrl` empty AND no routes — the same question `connectionRows()`
 *       answers with zero rows (S0), so a legacy `baseUrl` install is configured and is left alone.
 *   (b) **A Skip sticks.** `personae.wizard.v1` keeps `{dismissedAt}`; once it is set the wizard never
 *       auto-opens again. The user can still reach it from Gateway Settings — the flag closes the door
 *       on the automatic one only.
 *   (c) **It resumes.** The step (and the branch) are stored as the user moves, so leaving Settings
 *       mid-setup and coming back lands on the step they were on.
 *   (d) The S1 button always reaches it — that half is `src/gateway/plan.ts::WIZARD_BUTTON_ACTION`.
 *
 * The stored blob is a SEPARATE key from the settings (it is not a setting: it is a piece of UI state
 * that must survive a restart, and it must never sync — nothing here is in the preference document).
 */

import type { Settings } from '../settings';
import { storeGet, storeSet } from '../storage';

export const WIZARD_STATE_KEY = 'personae.wizard.v1';

export const WIZARD_BRANCH_IDS = ['lan', 'remote'] as const;
export type WizardBranchId = (typeof WIZARD_BRANCH_IDS)[number];

export type WizardState = {
  /** When the user skipped the automatic wizard, or null. Never cleared by anything automatic. */
  dismissedAt: number | null;
  /** The step the wizard was last on, or null. */
  step: string | null;
  /** Which setup path was chosen, or null (the LAN/Remote step itself). */
  branch: WizardBranchId | null;
};

export const DEFAULT_WIZARD_STATE: WizardState = { dismissedAt: null, step: null, branch: null };

function isBranch(value: unknown): value is WizardBranchId {
  return (WIZARD_BRANCH_IDS as readonly unknown[]).includes(value);
}

/** Coerce whatever came out of storage. Junk (or an old shape) is simply "nothing stored yet". */
export function normalizeWizardState(raw: unknown): WizardState {
  const row = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    dismissedAt: typeof row.dismissedAt === 'number' && Number.isFinite(row.dismissedAt) ? row.dismissedAt : null,
    step: typeof row.step === 'string' && row.step.trim() ? row.step.trim() : null,
    branch: isBranch(row.branch) ? row.branch : null,
  };
}

export async function loadWizardState(): Promise<WizardState> {
  const blob = await storeGet(WIZARD_STATE_KEY);
  if (!blob) return { ...DEFAULT_WIZARD_STATE };
  try {
    return normalizeWizardState(JSON.parse(blob));
  } catch {
    return { ...DEFAULT_WIZARD_STATE };
  }
}

export async function saveWizardState(state: WizardState): Promise<void> {
  await storeSet(WIZARD_STATE_KEY, JSON.stringify(normalizeWizardState(state)));
}

/** The patch a Skip writes: the moment it was skipped, and nothing else. */
export function dismissPatch(now: number): Partial<WizardState> {
  return { dismissedAt: now };
}

/** The patch a step change writes — the step, and the branch it belongs to. */
export function stepPatch(step: string, branch: WizardBranchId | null): Partial<WizardState> {
  return { step, branch };
}

/** The step to resume on. The branch step is where a wizard with nothing stored starts. */
export function resumeStep(state: WizardState): string {
  return state.step ?? 'kind';
}

/**
 * Does the wizard open by itself right now?
 *
 * It must be unconfigured (`baseUrl` empty AND no routes — S0's own reader), it must never have been
 * skipped, and it must not already be done. A test establishes the negative: a settings object with a
 * legacy `baseUrl` and no `routes` is CONFIGURED and never auto-opens.
 */
export function shouldAutoOpen(state: WizardState, settings: Pick<Settings, 'baseUrl' | 'routes'>): boolean {
  if (state.dismissedAt !== null) return false;
  const hasRoute = Array.isArray(settings.routes) && settings.routes.length > 0;
  const hasBase = Boolean(String(settings.baseUrl ?? '').trim());
  return !hasRoute && !hasBase;
}
