/**
 * Is the connection banner on screen? (0.9.0 Phase F — §4 items 2 and 10.)
 *
 * the user, verbatim: *"Remove the text regarding the connection."* The judgement the goal records (§5),
 * and the one this module implements, is that the banner was never a status strip — it exists so that
 * "wrong port", "Tailscale not running" and "no network" do not all look like an EMPTY LIST
 * (`src/ConnectivityBanner.tsx`). Removing it in every state re-introduces exactly that bug.
 *
 * So the ROUTINE strip goes, and the FAILURE disclosure stays:
 *
 *   * a failed profile list or a failed feed  → shown (the list is lying about being empty);
 *   * the connection failed AND nothing is on screen → shown (there is nothing else to read);
 *   * a healthy connection, or a failed one with rows already painted → NOT shown. The roster says
 *     what it has; a strip repeating "connected" is the text the operator asked to remove.
 *
 * `CONNECTION_STRIP_ALWAYS` is the one flag §5 promises: `true` restores 0.8.0's behaviour exactly,
 * with no other change, so the user can veto the judgement cheaply.
 */

import type { ConnectStage } from '../ConnectivityContext';

/** Flip to `true` to put the banner back in every state — 0.8.0's behaviour, one line. */
export const CONNECTION_STRIP_ALWAYS = false;

export type BannerInput = {
  stage: ConnectStage;
  /** `/api/profiles` failed on a surface that has profiles (F7). */
  contactError: boolean;
  /** The feed call failed. */
  feedError: boolean;
  /** How many list rows would paint right now. */
  rowCount: number;
};

export function showsConnectionBanner(input: BannerInput): boolean {
  if (CONNECTION_STRIP_ALWAYS) return true;
  if (input.contactError || input.feedError) return true;
  return input.stage === 'failed' && input.rowCount === 0;
}
