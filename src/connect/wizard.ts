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
