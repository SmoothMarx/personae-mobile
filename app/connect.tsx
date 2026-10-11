/**
 * Connect — the route, and nothing else (0.7.0).
 *
 * expo-router maps the deep link `personae://connect?base=…&code=…` onto THIS route with the query
 * as search params, both on cold start and when the app is already running — so the QR, the
 * in-app-browser redirect and a link opened from Telegram all arrive here and end in one redeem.
 *
 * The wizard itself now lives in `src/connect/Wizard.tsx`, because 0.7.0 draws the same three steps
 * inside Settings as the Connection section. This file is the thin host: it must keep existing (the
 * `personae://connect` deep link is registered against this route), and it must contain no copy of
 * the step logic — one implementation, two hosts.
 *
 *   1 · Service  — probe GET /api/health: name hermes-serve.service, or say what answered instead.
 *   2 · Sign in  — pair through the dashboard login, scan the QR, or paste a link.
 *   3 · Check    — GET /api/profiles with the new device token → "22 profiles found".
 */
import { useRouter } from 'expo-router';
import React from 'react';

import ConnectWizard from '../src/connect/Wizard';

export default function ConnectScreen() {
  const router = useRouter();
  return <ConnectWizard onDone={() => router.replace('/')} />;
}
