/**
 * Live harness: the APP's own pairing + sync code (src/pairing.ts, src/sync/uiSync.ts) against the
 * REAL dashboard on this box. Proves the interception point end-to-end without a phone:
 *   pair/start (owner credential) → the deep link the /pair page and QR carry → parseConnectLink
 *   → redeemPairing → GET /api/profiles with the device token → revoke → 401;
 *   then the sync client seeds/merges against the live /api/plugins/messenger/state.
 *
 *   HERMES_PERSONAE_BEARER=… npx tsx scripts/pair-harness.ts http://localhost:9119
 *
 * Never prints a code or a token ([REDACTED]).
 */
import { parseConnectLink, redeemPairing, revokeSelf, probeService } from '../src/pairing';
import { createUiSync, httpRemote, type SyncMeta } from '../src/sync/uiSync';

const base = (process.argv[2] || 'http://localhost:9119').replace(/\/+$/, '');
const owner = process.env.HERMES_PERSONAE_BEARER || '';
const out = (line: string) => process.stdout.write(`${line}\n`);

async function main() {
  if (!owner) throw new Error('set HERMES_PERSONAE_BEARER (the owner credential) in the environment');
  const verdict = await probeService(base);
  out(`probe ${base}: ${JSON.stringify(verdict)}`);
  const gw = await probeService(base.replace(':9119', ':9222'));
  out(`probe :9222: ${JSON.stringify(gw)}`);

  const started = await fetch(`${base}/api/plugins/personae-mobile-auth/pair/start`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${owner}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'harness (0.6.0)' }),
  });
  const s = (await started.json()) as { deep_link: string };
  out(`pair/start: ${started.status}, deep link = personae://connect?base=…&code=[REDACTED]&…`);

  const link = parseConnectLink(s.deep_link);
  if (!link) throw new Error('parseConnectLink rejected the server deep link');
  out(`parseConnectLink: ok (base=${link.base}, label=${link.label})`);

  const result = await redeemPairing(link);
  out(`redeemPairing: ok, device=${result.deviceId}, token=[REDACTED]`);
  try {
    await redeemPairing(link);
    out('second redeem: UNEXPECTEDLY OK');
  } catch (e) {
    out(`second redeem: ${(e as Error).message}`);
  }

  const profiles = await fetch(`${base}/api/profiles`, { headers: { Authorization: `Bearer ${result.token}` } });
  const n = ((await profiles.json()) as { profiles?: unknown[] }).profiles?.length ?? 0;
  out(`GET /api/profiles with the device token: ${profiles.status}, ${n} profiles`);

  // sync client against the live store, with the DEVICE token (in-memory meta only)
  let meta: SyncMeta | null = null;
  const adopted: string[] = [];
  const sync = createUiSync({
    remote: httpRemote(base, result.token),
    loadMeta: async () => meta,
    saveMeta: async (m) => {
      meta = JSON.parse(JSON.stringify(m));
    },
    onRemote: (key) => adopted.push(key),
  });
  const status = await sync.start({});
  out(`sync.start: ${status}; adopted from server: [${adopted.join(', ')}]`);
  sync.dispose();

  const ok = await revokeSelf(base, result.token, result.deviceId);
  const after = await fetch(`${base}/api/profiles`, { headers: { Authorization: `Bearer ${result.token}` } });
  out(`revokeSelf: ${ok}; /api/profiles after revoke: ${after.status}`);
  process.exit(after.status === 401 && n > 0 ? 0 : 1);
}

main().catch((e) => {
  out(`FAILED: ${(e as Error).message}`);
  process.exit(1);
});
