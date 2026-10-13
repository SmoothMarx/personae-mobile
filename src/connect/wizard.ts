/**
 * The connection wizard's steps, as data (0.7.0).
 *
 * `app/connect.tsx` documented three steps at its top and drew them inline; 0.7.0 needs those SAME
 * steps to appear inside Settings, as the Connection section — one implementation, two hosts. The
 * single implementation is `src/connect/Wizard.tsx`; this module is the list of what it draws, so
 * "the wizard has exactly these three steps and Settings renders them without navigating anywhere"
 * is an assertion rather than a comment.
 *
 * Titles resolve through `t` at CALL time: `t` is a live view over the current language, so caching
 * one of these strings at module scope would freeze whichever language loaded first.
 *
 *   1 · Service  — probe GET /api/health: name hermes-serve.service, or say what answered instead.
 *   2 · Sign in  — pair through the dashboard login, scan the QR, or paste a link.
 *   3 · Check    — GET /api/profiles with the new device token → "n profiles found".
 */

import { t } from '../i18n';

export const WIZARD_STEP_IDS = ['service', 'sign-in', 'check'] as const;
export type WizardStepId = (typeof WIZARD_STEP_IDS)[number];

export type WizardStep = {
  id: WizardStepId;
  title: string;
  /** True when the step's body is drawn in place (never behind a navigation). */
  inline: boolean;
};

export function wizardSteps(): WizardStep[] {
  return [
    { id: 'service', title: t.connect.step1, inline: true },
    { id: 'sign-in', title: t.connect.step2, inline: true },
    { id: 'check', title: t.connect.step3, inline: true },
  ];
}

export function wizardStepIds(): WizardStepId[] {
  return wizardSteps().map((step) => step.id);
}

/** The wizard drawn inside Settings must not push the route the user is already on. */
export function isInlineWizard(): boolean {
  return wizardSteps().every((step) => step.inline);
}

// ─────────────────────────── 0.10.0 S3: the branch step, and what a branch draws ──

/**
 * the user, 2026-10-13: *"The workflow of connection wizard should be the following. Ask whether the user
 * wants to set up a local (LAN) or a remote connection."*
 *
 * That question is a **branch** — *which setup path* — and NOT a new route model: both branches end in
 * the SAME three steps above (`service` → `sign-in` → `check`), then the test. A route's `role` stays
 * inferred from its address (`src/routes.ts:115`), so whatever the user picks here, the route that
 * comes out of it is classified by its own address and nothing else.
 *
 * The branch ids live here so the suite and the screen read one list.
 */
export const WIZARD_BRANCH_IDS = ['lan', 'remote'] as const;
export type WizardBranchId = (typeof WIZARD_BRANCH_IDS)[number];

export type WizardBranch = { id: WizardBranchId; title: string; help: string; bodyKey: string };

export function wizardBranches(): WizardBranch[] {
  return [
    { id: 'lan', title: t.settings.wizBranchLan, help: t.settings.wizBranchLanHelp, bodyKey: 'lan' },
    { id: 'remote', title: t.settings.wizBranchRemote, help: t.settings.wizBranchRemoteHelp, bodyKey: 'remote' },
  ];
}

export function wizardBranchIds(): WizardBranchId[] {
  return wizardBranches().map((branch) => branch.id);
}

/** The step that asks the question. It precedes the three 0.7.0 steps in both branches. */
export const WIZARD_BRANCH_STEP_ID = 'kind';

export type WizardPlanStepId = typeof WIZARD_BRANCH_STEP_ID | WizardStepId;

export type WizardPlanStep = { id: WizardPlanStepId; title: string; inline: boolean; branch: WizardBranchId | null };

/**
 * The whole wizard, as one ordered list: the branch question, then the three steps every branch keeps.
 * `wizardSteps()` is unchanged and still exactly three — the branch is drawn ON TOP of it, never
 * instead of it.
 */
export function wizardPlan(): WizardPlanStep[] {
  const branchStep: WizardPlanStep = { id: WIZARD_BRANCH_STEP_ID, title: t.settings.wizBranchTitle, inline: true, branch: null };
  const steps: WizardPlanStep[] = wizardSteps().map((step) => ({
    id: step.id,
    title: step.title,
    inline: step.inline,
    branch: null,
  }));
  return [branchStep, ...steps];
}

/** The three 0.7.0 steps a branch keeps, in order — the SAME three in either branch. */
export function branchSteps(_branch: WizardBranchId): WizardStep[] {
  return wizardSteps();
}

// ── the Remote branch's rows, and the ONE of them that is Android-only ─────────────────────────────

export const REMOTE_ROW_IDS = ['peers', 'manual', 'tunnel', 'test'] as const;
export type RemoteRowId = (typeof REMOTE_ROW_IDS)[number];

/**
 * Is the tunnel row drawn on this platform?
 *
 * **Android only** — the user's call, and decision §3.6. On iOS the row is not rendered AT ALL: not
 * disabled, not greyed, with no help sentence apologising for a platform limit. The reason is
 * structural rather than a preference: the broadcast is `com.tailscale.ipn.CONNECT_VPN` through
 * `src/native/tailscale.ts`, the native module has no iOS half, and iOS gives an app no cross-app
 * visibility at all. `openTailscaleOnFailure` (a deep link that starts nothing) stays on both.
 */
export function tunnelRowVisible(platform: string): boolean {
  return platform === 'android';
}

/** The rows one branch draws, on one platform. The tunnel row is missing on iOS, not disabled. */
export function branchRows(branch: WizardBranchId, platform: string): string[] {
  if (branch === 'lan') return ['address', 'link', 'login', 'test'];
  return REMOTE_ROW_IDS.filter((id) => id !== 'tunnel' || tunnelRowVisible(platform)).map((id) => String(id));
}

/**
 * Is the Tailscale install check drawn on this platform? Android only, for the same reason as the
 * tunnel row: `isPackageInstalled` reads Android's package manager and there is no iOS half. On iOS the
 * branch goes straight to the peer list / manual entry, and the test connection (S3.3) is the honest
 * signal for a phone that is not on the tailnet.
 */
export function installCheckVisible(platform: string): boolean {
  return platform === 'android';
}

// ─────────────────────────── 0.10.1 S3: step 1 reports; it does not ask again ──

/**
 * the user, 2026-10-13: *"Does the '1. Service' have to exist or has it become redundant?"* — and his
 * pick, verbatim: **"Result, not input: auto-probe the address the branch already set, keep the
 * field read-only-ish for correction, keep the wrong-service diagnosis (smallest change — wizard
 * stays 3 steps)"**.
 *
 * The step's **diagnosis** is not redundant: nothing else catches "you pointed at
 * hermes-gateway.service — no profiles, no sessions, the dashboard is :9119" and offers the one-tap
 * correction (`t.connect.isGateway` + `t.connect.useDashboardPort`). The step's **input** was
 * redundant: `useLanAddress`, `useRemoteAddress` and `pickPeer` each already build the URL, store
 * it and move to step 1, so the screen was asking the user to type the address it had just written.
 *
 * Both decisions are FUNCTIONS rather than comments, because `Wizard.tsx` cannot be rendered on this
 * host (no device, no renderer): the suite can then *prove* the one-probe guard and the disclosure's
 * initial state instead of reading around them.
 */
export type ServiceEntry = 'address-in-hand' | 'no-address';

/**
 * How the wizard ENTERED step 1, which is what decides whether the editable field starts open.
 *
 * Arriving from the branch card or a picked device means the address is already known, and the field
 * is a CORRECTION — one tap away, closed by default. Entering with nothing (a resume with no stored
 * address, the standalone route, a fresh install) means the user genuinely has to type one, so there
 * it is open.
 */
export function addressFieldOpen(entry: ServiceEntry): boolean {
  return entry === 'no-address';
}

/** The entry the branch card and a picked device produce. Named so the screen cannot pass a typo. */
export const SERVICE_ENTRY_WITH_ADDRESS: ServiceEntry = 'address-in-hand';

/**
 * Should step 1 probe by ITSELF, right now? `null` means no.
 *
 * The rule, and the only one: probe when the wizard is ON step 1, the address is not blank, and it is
 * not the address that was already probed. That makes entering the step probe exactly ONCE (the
 * caller stamps `lastProbed` with what this returned), a re-render probe not at all, and a CHANGED
 * address probe again — which is the whole of "the step opens as a result". A blank address is never
 * probed: an empty URL is not a diagnosis, it is a question the user has not answered yet.
 */
export function autoProbeTarget(step: string, address: string, lastProbed: string): string | null {
  if (step !== 'service') return null;
  const value = String(address ?? '').trim();
  if (!value) return null;
  return value === lastProbed ? null : value;
}
