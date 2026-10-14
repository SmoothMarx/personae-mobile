/**
 * 0.14.0 W1 — THE WIRE LOG. Evidence for the close-out, not a test.
 *
 * Runs against `mock/dashboard.mjs`, whose WebSocket dispatch mirrors the gateway's own: every
 * session-scoped RPC is resolved out of an in-memory map (`_sess_nowait`, `tui_gateway/server.py
 * :1228-1244` — a miss is `4001 session not found`), and `session.resume` MINTS a new runtime id
 * (`methods_session.py:894-905`). `sess-1` is seeded as NOT resident, which is the condition the
 * phone's second message hits.
 *
 * It prints, in order: the failing RPC and its params, the answer it got, the resume and the
 * `session_id` IT RETURNED, and the retry with the id it actually sent plus its answer. Then the
 * same sequence driven through the app's own `Backend` (`chatStream`).
 *
 *   npx tsx logs/wire-0.14.0.ts > logs/wire-0.14.0.txt
 */
import { createMockDashboard } from '../mock/dashboard.mjs';
import { createDashboardClient } from '../src/api/dashboard';
import { createBackend } from '../src/api/backend';
import { DEFAULT_SETTINGS } from '../src/settings';

const BEARER = 'test-bearer-0123456789abcdef0123456789abcdef';
const STORED = 'sess-1';

function line(what: string, value: unknown): void {
  console.log(`${what}: ${JSON.stringify(value)}`);
}

async function main(): Promise<void> {
  const mock = createMockDashboard({ port: 0, bearer: BEARER, coldSessions: [STORED], resumeMint: true });
  await mock.listen();
  console.log(`# mock gateway on ${mock.url} — ${STORED} is NOT resident, session.resume mints a new id`);

  // ── 1. The raw wire: the three calls the app's SECOND message makes ───────────────────────
  const socket = await createDashboardClient({ ...DEFAULT_SETTINGS, baseUrl: mock.url, apiKey: BEARER }, {}).connect({});
  console.log('\n── the raw wire ──');
  line('  1. prompt.submit (the id the roster holds)', { session_id: STORED, text: 'segunda mensagem' });
  try {
    const answer = await socket.rpc('prompt.submit', { session_id: STORED, text: 'segunda mensagem' });
    line('     -> answer', answer);
  } catch (error) {
    line('     -> rejected', { status: (error as { status?: number }).status, message: (error as Error).message });
  }

  line('  2. session.resume (the STORED key)', { session_id: STORED });
  const resumed = (await socket.rpc<Record<string, unknown>>('session.resume', { session_id: STORED })) ?? {};
  line('     -> the runtime lease it RETURNED', resumed.session_id);
  line('     -> the stored key, named back', resumed.resumed ?? resumed.session_key);

  const lease = String(resumed.session_id ?? '');
  line('  3. prompt.submit (the LEASE the resume returned)', { session_id: lease, text: 'segunda mensagem' });
  try {
    const answer = await socket.rpc('prompt.submit', { session_id: lease, text: 'segunda mensagem' });
    line('     -> answer', answer);
  } catch (error) {
    line('     -> rejected', { status: (error as { status?: number }).status, message: (error as Error).message });
  }
  socket.close();
  console.log(`\n  in order: ${mock.rpcCalls.map((call) => `${call.method}(${String(call.params.session_id)})`).join(' -> ')}`);
  await mock.close();

  // ── 2. The same sequence through the APP's own backend, on a FRESH gateway ────────────────
  // A fresh instance because part 1's resume superseded `sess-1` — one cold session per run.
  const gateway = createMockDashboard({ port: 0, bearer: BEARER, coldSessions: [STORED], resumeMint: true });
  await gateway.listen();
  gateway.rpcCalls.length = 0;
  const backend = createBackend({ ...DEFAULT_SETTINGS, baseUrl: gateway.url, apiKey: BEARER });
  console.log('\n── through the app: backend.chatStream (the text path) ──');
  const outcome = await new Promise<string>((resolve) => {
    let seen: unknown = null;
    backend.chatStream(
      STORED,
      'segunda mensagem',
      {
        onError: (error) => {
          seen = error;
        },
        onClose: ({ aborted }) =>
          resolve(seen ? `turn failed (${JSON.stringify(seen)})` : `turn closed normally (aborted=${aborted})`),
      },
      '',
    );
  });
  line('  the app saw', outcome);
  for (const call of gateway.rpcCalls) line(`  sent ${call.method}`, call.params.session_id);
  line('  resumes on the wire', gateway.rpcCalls.filter((call) => call.method === 'session.resume').length);

  // ── 3. And the send AFTER it: same session, no further resume ────────────────────────────
  gateway.rpcCalls.length = 0;
  await new Promise<void>((resolve) => {
    backend.chatStream(STORED, 'terceira mensagem', { onError: () => undefined, onClose: () => resolve() }, '');
  });
  line('\n  the NEXT send', gateway.rpcCalls.map((call) => ({ method: call.method, session_id: call.params.session_id })));

  backend.dispose();
  await gateway.close();
}

void main();
