/**
 * Single string table for the whole app, in two languages.
 *
 * Language decision (2026-10-11, revised): English is the source-of-truth table and the default for
 * a fresh install; PT-PT is kept as a full translation and selectable in Settings (live switch).
 * An install that already had saved settings before the switch existed keeps Portuguese (see
 * settingsStore.loadSettings). Plain language, for a non-technical user. Every user-visible string
 * lives here — see QUESTIONS.md Q4.
 *
 * `t` is a LIVE view: every property read resolves against the current language, so call sites
 * keep writing `t.roster.title` and get the right language at render time. Never cache a `t.*`
 * value at module scope.
 */

import { useSyncExternalStore } from 'react';

export type Language = 'en' | 'pt';
export const LANGUAGES: readonly Language[] = ['en', 'pt'];
export const DEFAULT_LANGUAGE: Language = 'en';

export function isLanguage(value: unknown): value is Language {
  return value === 'en' || value === 'pt';
}

const en = {
  appName: 'Personae',
  loading: 'Loading…',
  retry: 'Try again',

  roster: {
    title: 'Personae',
    profiles: 'Profiles',
    primary: 'Main',
    allProfiles: 'All',
    sessions: 'Sessions',
    sessionsOf: (name: string) => `Sessions · ${name}`,
    emptyTitle: 'No sessions yet',
    emptyBody: 'When this profile has sessions, they show up here.',
    newSession: 'New session',
    newSessionTitle: 'New session',
    newSessionPlaceholder: 'Session title (optional)',
    create: 'Create',
    cancel: 'Cancel',
    open: 'Open',
    openSettings: 'Settings',
    notConfiguredTitle: 'Setup needed',
    notConfiguredBody: 'Enter the server address and the API key in Settings to get started.',
    page: (cur: number, total: number, from: number, to: number, all: number) =>
      `Page ${cur} of ${total} · ${from}–${to} of ${all}`,
    prev: 'Previous',
    next: 'Next',
    newBadge: (n: number) => (n > 0 ? `${n} new` : ''),
    newTag: 'new',
    messages: (n: number) => `${n} message${n === 1 ? '' : 's'}`,

    // ── the roster proper (0.5.0): a vertical list of faces that expand in place ──
    searchPlaceholder: 'Search profiles and conversations…',
    searchClear: 'Clear',
    searchResults: (n: number) => (n === 1 ? '1 result' : `${n} results`),
    searchEmpty: 'Nothing found. Try another word.',
    searchBodyHint: 'Includes the text of messages.',
    expandAll: 'Open all',
    collapseAll: 'Close all',
    automatic: 'Automatic',
    automaticCount: (n: number) => (n === 1 ? '1 automatic run' : `${n} automatic runs`),
    automaticHelp:
      'Runs of scheduled tasks. They are not conversations; they are listed here only so you can see them.',
    // ── which session types the list shows (0.8.0 D) ──────────────────────
    types: {
      noneTitle: 'No session types are selected',
      noneBody: 'Check at least one session type in Settings to see sessions here.',
      noneAction: 'Open Settings',
      hidden: (n: number) =>
        n === 1
          ? '1 automatic run is hidden — turn automatic runs on in Settings.'
          : `${n} automatic runs are hidden — turn automatic runs on in Settings.`,
    },
    // ── 0.9.0 E: multiselect, the WhatsApp model ──
    selection: {
      count: (n: number) => `${n} selected`,
      selectAll: 'Select all',
      clear: 'Clear',
      close: 'Close',
      archive: 'Archive',
      delete: 'Delete',
      done: 'Done',
      apropos: 'Apropos',
      deleteConfirm: (n: number) =>
        `Delete ${n === 1 ? '1 session' : `${n} sessions`}? This cannot be undone.`,
      partial: (failed: number, total: number) => `${failed} of ${total} did not work.`,
    },

    // ── 0.9.0 C: user-authored SESSION groups (the desktop pane's Groups) ──
    sessionGroups: {
      toggle: (name: string, count: number) => `${name}, ${count} ${count === 1 ? 'session' : 'sessions'}`,
      newTitle: 'New group',
      namePlaceholder: 'Group name',
      create: 'Create',
      rename: 'Rename group',
      delete: 'Delete group',
      deleteConfirm: (name: string) =>
        `Delete the group "${name}"? The sessions inside it are NOT deleted — they go back to the list.`,
      moveUp: 'Move up',
      moveDown: 'Move down',
      fileInto: 'File into a group',
      removeFrom: 'Remove from the group',
      none: 'No group',
      filed: (name: string) => `Filed under "${name}".`,
      ungrouped: 'Ungrouped',
      empty: 'Empty group — long-press a session to file it here.',
    },

    // ── the swipe on a session row (0.8.0 E): short labels — they live in 76 dp buttons ──
    swipe: {
      archive: 'Archive',
      delete: 'Delete',
      confirm: 'Confirm',
      confirmDelete: 'Tap again to delete for good',
      confirmCancel: 'Cancel',
      a11yHint: 'Slide left for archive and delete.',
    },
    noSessions: 'No conversations in this profile.',
    profileErrorTitle: 'Could not read the list of profiles',
    profileErrorBody:
      'The server answered, but did not give the list of profiles. This is not the same as "there are no profiles" — see the error below and the support log.',
    surfaceNoProfiles:
      'This connection is the gateway API (:9222), which has no list of profiles. To see all your profiles, switch to Dashboard (:9119) in Settings.',

    groups: {
      title: 'Groups',
      ungrouped: 'No group',
      new: 'New group',
      namePlaceholder: 'Group name',
      create: 'Create group',
      rename: 'Rename',
      renamePrompt: 'Group name',
      delete: 'Delete group',
      deleteConfirm: (name: string) =>
        `Delete the group "${name}"? Conversations are not touched: the profiles go back to "No group".`,
      empty: 'Empty group. Press and hold a profile and choose "Move to group" to put it here.',
      assign: 'Move to group',
      assignment: (name: string) => `Move to "${name}"`,
      remove: 'Remove from group',
      help: 'Group profiles under a name. Deleting a group never deletes conversations.',
    },

    menu: {
      title: 'Actions',
      newSession: 'New session',
      rename: 'Rename…',
      renamePrompt: 'New name',
      localOnly: 'on this phone only',
      colour: 'Colour',
      colourNone: 'No colour',
      hide: 'Hide profile',
      // ── 0.9.0 D: the desktop's own per-object inventory, verb for verb ──
      select: 'Select',
      openHere: 'Open',
      openWindow: 'In new window',
      openTab: 'In new tab',
      sessionMenu: 'Session',
      markUnread: 'Mark as unread',
      branch: 'Branch',
      branchFailed: 'The gateway did not return a new session.',
      exportSession: 'Export…',
      hideSession: 'Hide from Personae',
      unhideSession: 'Unhide in Personae',
      apropos: 'Apropos (On that topic, beta)',
      aproposSession: 'From this session',
      aproposGroup: 'Create group',
      aproposGroupHeading: 'Apropos this group (beta)',
      newSessionGroup: 'New session group',
      moveToGroup: 'Move to group',
      ungroupedPick: 'Ungrouped',
      project: 'Assign to project',
      openNewest: 'Open newest session',
      moveUp: 'Move up',
      moveDown: 'Move down',
      unhide: 'Show profile',
      archiveAll: 'Archive all conversations',
      archiveAllConfirm: (label: string) =>
        `Archive all conversations of ${label}? Nothing is deleted — they stay archived on the server.`,
      open: 'Open',
      copyId: 'Copy ID',
      copied: 'ID copied.',
      sessionColour: 'Conversation colour',
      archive: 'Archive conversation',
      deleteSession: 'Delete conversation',
      deleteSessionConfirm: (title: string) => `Delete the conversation "${title}"? This cannot be undone.`,
      deleted: 'Conversation deleted.',
      group: 'Group',
      sort: 'Sort',
      sortActivity: 'By activity',
      sortName: 'By name',
      sortSessions: 'By number of conversations',
      cancel: 'Cancel',
    },

    lights: {
      waiting: 'Waiting for you',
      unread: 'Unread',
      idle: 'Nothing pending',
      fresh: (n: number) => (n === 1 ? '1 new since your last visit' : `${n} new since your last visit`),
    },
  },

  thread: {
    // ── 0.9.0 G: attachments, WhatsApp's shape ──
    attach: {
      add: 'Add an attachment',
      camera: 'Take a photo',
      clipboard: 'Paste an image',
      document: 'Send a file',
      documentReason:
        'Choosing a file from this phone needs a file picker that is not built yet. Pictures work today.',
      capture: 'Take the photo',
      captureFailed: 'The camera did not return a picture.',
      cameraDenied: 'The camera permission was refused, so a photo cannot be taken.',
      clipboardEmpty: 'There is no image on the clipboard.',
      clipboardFailed: (detail: string) => `The clipboard could not be read: ${detail}`,
      refused: (name: string, reason: string) => `${name} was not added. ${reason}`,
      remove: 'Remove',
      imageLabel: 'Attached picture',
    },
    // ── 0.9.0 H: voice notes ──
    voice: {
      hold: 'Hold to record a voice note',
      slideToCancel: 'Slide left to cancel, release to keep',
      releaseToCancel: 'Release to cancel',
      cancelled: 'The voice note was cancelled.',
      tooShort: 'Too short — hold a little longer to send a voice note.',
      permissionDenied: 'The microphone permission was refused, so a voice note cannot be recorded.',
      recordFailed: (detail: string) => `The recording failed: ${detail}`,
      playback: (name: string) => `Voice note ${name}`,
      sending: 'Voice note',
    },
    you: 'You',
    agent: 'Agent',
    tools: (n: number) => `${n} tool call${n === 1 ? '' : 's'}`,
    showTools: 'Show details',
    hideTools: 'Hide details',
    reasoning: 'Thinking',
    toolArgs: 'Arguments',
    toolResult: 'Result',
    toolNoResult: 'no result',
    toolFailed: 'failed',
    orphanTool: 'result with no matching call',
    liveActivity: 'Live activity',
    liveToolDone: 'done',
    liveToolRunning: 'running…',
    composerPlaceholder: 'Write a message…',
    send: 'Send',
    stop: 'Stop',
    thinking: 'Thinking…',
    historical: 'history',
    streamed: 'live',
    emptyThread: 'No messages in this session. Write the first one.',
    stopped: 'Reply stopped. The text received so far was kept.',
    fellBack: 'Live mode failed; the reply was requested again in one piece.',
    truncated: (n: number) => `(+${n} characters)`,
  },

  plus: {
    title: 'New',
    newGroup: 'New group',
    newProfile: 'New profile',
    newSession: 'New session',
    pickProfile: 'Which profile should own it?',
    profileName: 'Profile name',
    profileNamePlaceholder: 'e.g. research',
    create: 'Create',
    created: (name: string) => `Profile "${name}" created.`,
    createRefused: (reason: string) => `This phone cannot create profiles: ${reason}`,
    createUnavailable: 'Only on the Dashboard connection.',
    invalidName: 'That name cannot be used for a profile.',
  },

  settings: {
    title: 'Settings',
    surface: 'Connection type',
    surfaceHelp:
      'Only one thing is required: the connection type must be "Dashboard (:9119)" and the credential must be the app bearer token. The gateway API (:9222) still works, but has no profiles or groups.',
    surfaceCheckOk: 'Dashboard (:9119) + bearer token — filled in. Use "Test connection" to confirm.',
    surfaceCheckPending:
      'Choose "Dashboard (:9119)" or fill in the credential (the bearer token). That pair is the only thing required.',
    gatewayNoProfiles:
      'The gateway API (:9222) has no list of profiles: the roster will have no profiles, no groups and no per-profile conversations. Switch to "Dashboard (:9119)" to see everything.',
    baseUrl: 'Server address',
    baseUrlHelp: 'E.g. http://10.0.0.5:9119',
    baseUrlHelpGateway: 'E.g. http://10.0.0.5:9222',
    // ── display session types (0.8.0 D; renamed and widened in 0.9.1 S4.2) ──
    // THE NAME IS THE POINT: this is what the list SHOWS, not a capability being switched on. Nothing
    // here stops anything running.
    sessionTypes: 'Display session types',
    sessionTypesHelp:
      'What the session list shows. This is a display filter: nothing is turned off or changed by it, and each kind can be shown or hidden on its own.',
    typeSessions: 'Sessions',
    typeSessionsHelp: 'Conversations you have with a profile.',
    typeCron: 'Cron',
    typeCronHelp: 'Scheduled jobs. They run on the box whether or not they are shown here.',
    typeWebhook: 'Webhooks',
    typeWebhookHelp: 'Runs started by something outside, such as a hook.',
    typeOneshot: 'One-shots',
    typeOneshotHelp: 'Runs made once, by hand or by another tool.',
    // SUPERSEDED IN 0.9.1 (S4.2): `typeAutomatic` = 'Automatic runs (cron, webhooks)' was the one label
    // that bundled three kinds together. It is kept here (and in PT, unreachable) rather than deleted —
    // removing a string is a separate decision. `typeNoneWarning` still says what to do with none
    // checked, and now means all FOUR.
    typeAutomatic: 'Automatic runs (cron, webhooks)',
    typeAutomaticHelp: 'Scheduled jobs that ran on their own. They are not conversations.',
    typeNoneWarning: 'No type is checked, so the session list is empty. Check one to see sessions.',
    profilesFound: 'profiles found',
    logTitle: 'Support log',
    logHelp:
      'A .txt file with what the app tried and what failed. Nothing is sent anywhere: it is only shared when you press the button.',
    logPlaceholder: 'Describe what happened here (optional)…',
    logExport: 'Share log',
    logClear: 'Clear',
    logShared: 'Log created and handed to the share menu.',
    logCleared: 'Log cleared.',
    logFailed: 'Could not share the log.',
    apiKey: 'API key',
    apiKeyHelp: "Stored in the phone's secure storage. It never leaves the phone.",
    apiKeySet: 'saved',
    apiKeyUnset: 'not set',
    profiles: 'Extra profiles (prefix)',
    profilesHelp: 'One name per line. Each one is served at /p/<profile>/.',
    model: 'Model (optional)',
    modelHelp: "Leave empty to use the gateway's default model.",
    effective: 'In use now',
    clear: 'Clear',
    saved: 'Saved',
    savedKey: 'Key saved',
    clearKey: 'Delete key',
    clearKeyConfirm: 'Delete the API key saved on this phone?',
    testConnection: 'Test connection',
    testing: 'Testing…',
    testOk: (v: string) => `Connection OK · version ${v}`,
    testFail: 'Failed',
    autoSave: 'Each field saves itself.',
    showKey: 'Show',
    hideKey: 'Hide',
    valueSet: 'set',
    valueUnset: 'empty',
    surfaceDashboard: 'Dashboard (:9119)',
    surfaceGateway: 'Gateway API (:9222)',
    keyChars: (n: number) => `${n} characters`,
    keyPlaceholderDashboard: 'Dashboard bearer token',
    keyPlaceholderGateway: 'API_SERVER_KEY',
    modelDefault: "the gateway's default model",
    ignored: (list: string) => `Ignored: ${list}`,
    logLines: (n: number) => `${n} lines`,
    logFileName: 'personae-support-log.txt',
    language: 'Language / Língua',
    languageHelp: 'Changes straight away. Also sets the language of the support log.',
    languageEnglish: 'English',
    languagePortuguese: 'Português',
    advanced: 'Advanced',
    advancedHelp:
      'Connection type, address, key, routes, tailnet internals, status and the log. Nothing here is needed for normal use.',
    advancedShow: 'Show advanced settings',
    advancedHide: 'Hide advanced settings',
    // ── 0.9.0 B: Settings as a page of rows ──────────────────────────────
    pagesTitle: 'Settings',
    pagesHelp: 'Each row opens its own page. Everything below it is unchanged.',
    pages: {
      agentTitle: 'Agent Preferences',
      agentHelp: 'Which session types the list shows, and how the list is displayed.',
      notificationsTitle: 'Notifications',
      notificationsHelp: 'Which checkpoints warn you, and the phone permission they need.',
      gatewayTitle: 'Gateway Settings',
      gatewayHelp: 'How this phone reaches the gateway: pairing, Tailscale, address and key. Advanced lives inside this page.',
      advancedTitle: 'Advanced',
      advancedHelp: 'Connection type, address, key, routes, tailnet internals, status and the log.',
    },
    scopeTitle: 'What syncs',
    scopePortable: 'Syncs',
    scopeDeviceLocal: 'This phone only',
    scopeMixed: 'Partly syncs',
    scopeHelp:
      'A setting is either shared with the desktop or kept on this phone. A gateway address or a key is never shared: the desktop dials itself and this phone dials the tailnet.',
    scopeOpen: 'See what is shared',

    // ── 0.10.0: Gateway Settings and the connection wizard ───────────────────
    // The two nouns the user uses for the two kinds of connection, and the only words the connections
    // dropdown adds of its own: every other role keeps its `roleLabel()` name (src/routes.ts).
    gwKindLocal: 'Local',
    gwKindRemote: 'Remote',
    // The page plan (src/gateway/plan.ts). `link` and `advanced` are NOT here: they already had copy
    // of their own before this batch (`t.connectivity.*`, and the advanced page's own row).
    gwConnectionsTitle: 'Connections',
    gwConnectionsHelp: 'Every address this phone can reach the gateway on, in the order it tries them.',
    gwStatusTitle: 'Connection status',
    gwStatusHelp: 'What this phone knows about the connection you picked above.',
    gwPickOne: 'Pick a connection above to see its status.',
    gwKindsTitle: 'Preferred connection kind',
    gwKindsHelp: 'Which kind to prefer when both answer. Automatic always follows the order above.',
    gwWizardButton: 'Connection Wizard',
    gwWizardHelp: 'Set up a connection, local or remote, step by step.',
    gwFieldOrigin: 'Address',
    gwFieldRole: 'Kind',
    gwFieldSecurity: 'Encryption',
    gwFieldSurface: 'Interface',
    gwFieldServer: 'Server',
    gwFieldDevice: 'This phone',
    gwFieldLastSeen: 'Last seen',
    gwUnknown: 'Not known yet',
    gwNone: 'None',
    gwNoDevice: 'Not paired',
    gwNever: 'Never',
  },

  routes: {
    title: 'Routes',
    help:
      'The same gateway can be reached in several ways. The app tries them in order and uses the first one that answers.',
    empty: 'No routes yet. Type one below.',
    add: 'Add route',
    placeholder: 'http://10.0.0.5:9222',
    roleLan: 'Local network',
    roleTailscale: 'Tailscale',
    rolePublic: 'Internet (public)',
    customRole: (role: string) => `Custom (${role})`,
    inferred: 'Worked out from the address',
    invalid: 'Invalid address',
    problemBadUrl: 'Invalid address — it must start with http:// or https://',
    problemPublicHttp:
      'A public address must use https://. This one will not be used while it is http://.',
    problemNeedsAck:
      'http:// route on a private network: it has no app-level encryption. Allow it below to use it.',
    moveUp: 'Up',
    moveDown: 'Down',
    remove: 'Remove',
    removeConfirm: (url: string) => `Remove the route ${url}?`,
    priorityLabel: (n: number) => `priority ${n}`,
    ackTitle: 'Allow http:// routes beyond this phone',
    ackHelp:
      "Private route without app-level encryption. Traffic is still encrypted by Tailscale's WireGuard when the address is on your tailnet.",
    preferredTitle: 'Preferred route',
    preferredAuto: 'Automatic',
    preferredHelp: 'Automatic always picks by priority order.',
    secTailscaleTls: 'App-level encryption (.ts.net certificate)',
    secTailscaleWireguard:
      "No app-level encryption — encrypted by Tailscale's WireGuard",
    secLocalTls: 'App-level encryption',
    secLocalPlain: 'No encryption — private local network',
    secPublicTls: 'App-level encryption',
    secPublicPlain: 'No encryption — public address (only https:// is accepted)',
  },

  connectivity: {
    title: 'Connection',
    tailscaleInstalled: 'Tailscale installed',
    autoConnect: 'Connect the tunnel automatically on open',
    autoConnectHelp:
      'Asks the Tailscale app to connect when this app opens and when it comes back to the foreground.',
    tailscalePackage: 'Tailscale package',
    tailscalePackageHelp: 'Only change this if you use a modified version of the app.',
    connectDeadline: 'Maximum wait (s)',
    probeTimeout: 'Time per attempt (s)',
    openOnFailure: 'Open Tailscale when the connection fails',
    diagnosticsTitle: 'Connection status',
    diagInstalled: 'Tailscale installed',
    diagTunnel: 'Tunnel',
    diagRoute: 'Chosen route',
    diagGateway: 'Gateway answering',
    diagEverWorked: 'Has ever connected',
    diagLastError: 'Last error',
    diagPinBypassed: (role: string) =>
      `The preferred route (${role}) did not answer; another one was used.`,
    yes: 'Yes',
    no: 'No',
    unknown: 'Not known yet',
    tunnelUp: 'Connected',
    tunnelDown: 'Disconnected',
    tunnelProbing: 'Connecting…',
    noneChosen: 'None',
    diagTrigger: 'Last request to the tunnel',
    diagVpnHint: 'The active network has a VPN — a hint, not proof',
    diagHealthCaveat:
      '/v1/health answering proves the route reaches the gateway; it does not prove a conversation will work.',
    diagNotAvailable: 'Android only',
    recheck: 'Check again',
    setupIncomplete:
      'The tunnel was not ready in time. Open Tailscale, turn it on, and come back here.',
    openTailscale: 'Open Tailscale',
    notInstalled:
      'The Tailscale app is not installed on this phone. Install it or use a local network route.',
    permanentKey:
      'The API key was refused. Fix the key in Settings — trying again will not help.',
    iosNote:
      'On iPhone, Tailscale cannot be turned on from here: there is no way for apps to do this. Turn on "On-Demand" in the Tailscale settings and the app will connect by itself.',
    probeNoHostPort: 'address has no host or port',
    probeNoAnswer: (hostPort: string, ms: number) => `${hostPort} did not answer within ${ms} ms`,
    probeOpenNoReply: 'the connection opened but nothing answered',
    triggerSent: 'sent',
    triggerNotSent: 'not sent',
    triggerAutoOff: 'automatic connection off',
    triggerUnavailable: 'not available on this platform',
    logIn: 'Log in to Tailscale',
    logInHelp:
      'Opens the Tailscale app. Sign in there and turn the tunnel on, then come back — no app can sign in for you.',
    chooseDevice: 'Choose device',
    chooseDeviceHelp:
      'Lists the machines this server can see on the tailnet, and adds the one you pick as a route once it answers.',
    devicesTitle: 'Devices on the tailnet',
    devicesLoading: 'Reading devices…',
    devicesRetry: 'Read again',
    devicesUnavailable: (reason: string) =>
      `Could not read the device list (${reason}). Type the address under Advanced instead.`,
    devicesEmpty: 'No other machine is visible on the tailnet right now. Type the address under Advanced instead.',
    peerSelf: 'this server',
    peerOnline: 'online',
    peerOffline: 'offline',
    peerAdded: (name: string, address: string) => `${name} added as a route (${address}).`,
    peerNotAnswering: (name: string, address: string) => `${name} did not answer at ${address}. Nothing was added.`,
    peerAlreadyRoute: (address: string) => `${address} is already a route.`,
  },

  errors: {
    noBaseUrl: 'The server address is missing. Open Settings and enter it.',
    badBaseUrl: (v: string) => `The address "${v}" is not valid. It must start with http:// or https://`,
    noKey: 'The API key is missing. Open Settings and enter it.',
    unauthorized:
      'The gateway refused the API key (401). Check the key in Settings.',
    unauthorizedProfile: (p: string) =>
      `The gateway refused the API key (401) for the profile "${p}". Check the key and the profile name.`,
    network: (detail: string) =>
      `Could not reach the gateway. Check the address and that you are on the same network. (${detail})`,
    timeout: (sec: number) => `The gateway did not answer within ${sec} s.`,
    notFound: (what: string) => `${what} does not exist on the gateway (404).`,
    sessionGone: 'This session no longer exists on the gateway.',
    server: (status: number, detail: string) => `Gateway error (${status}): ${detail}`,
    badJson: 'The gateway reply is not valid JSON.',
    badStream: 'The live stream arrived in an invalid format.',
    missingMessage: "The 'message' field is missing.",
    streamDropped: 'The live stream dropped before the end.',
    sessionNoId: 'session has no id',
    turnFailed: 'error during the turn',
    streamFailed: 'error in the stream',
    rpcFailed: 'RPC error',
    internal: 'internal error',
    archiveUnsupported: 'archiving is not supported on this connection',
    profileCreateUnsupported: 'creating profiles is not supported on this connection',
    deleteUnsupported: 'deleting is not supported on this connection',
    renameUnsupported: 'renaming is not supported on this connection',
    // 0.9.0 D — the two session verbs the legacy surface cannot reach.
    flagsUnsupported: 'hiding and unread marks are not supported on this connection',
    attachUnsupported: 'sending pictures is not supported on this connection',
    branchUnsupported: 'branching a session is not supported on this connection',
    ticketMissing: 'ticket missing',
    resource: 'The item',
  },

  status: {
    ok: 'Answering',
    degraded: 'Unstable',
    down: 'Not answering',
    unknown: 'Not tested',
    auth: 'Key refused',
  },

  time: {
    justNow: 'just now',
    minutesAgo: (n: number) => `${n} min ago`,
    hoursAgo: (n: number) => `${n} h ago`,
    daysAgo: (n: number) => `${n} d ago`,
  },

  /** The exported support log (header lines + the per-call lines written while the app runs). */
  log: {
    docTitle: 'Personae — support log',
    generated: (stamp: string) => `Generated: ${stamp}`,
    userNote: 'What happened (in your words):',
    context: 'Context',
    connection: (surface: string, url: string) => `Connection: ${surface} · ${url}`,
    noAddress: 'no address',
    activeRoute: (url: string) => `Route in use: ${url}`,
    candidateRoutes: 'Candidate routes (by priority):',
    recentFailures: 'Recent failures:',
    device: (os: string) => `Device: ${os}`,
    notAvailable: 'n/a',
    entries: (n: number) => `Log (${n} lines, oldest first)`,
    empty: '(empty)',
    redactionNote: 'Note: authentication headers, tickets and tokens are replaced with [REDACTED].',
    attempt: (n: number) => ` (attempt ${n})`,
    noResponse: 'no response',
    took: (status: string, ms: number) => `${status} in ${ms} ms`,
    timedOut: (ms: number) => `timed out (${ms} ms)`,
    networkFailure: 'network failure',
    wsOpening: (url: string, ttl: number) => `opening /api/ws with a fresh ticket (${url}, ttl ${ttl} s)`,
    wsFailure: 'WebSocket failure',
  },

  /**
   * Accessibility labels (F2): every icon-only control needs one, or it is unusable with a
   * screen reader. Kept apart from the visible copy so a label can be longer than a caption.
   */
  a11y: {
    avatar: (name: string) => `Profile picture of ${name}`,
    contact: (label: string, hasAvatar: boolean) =>
      `Profile ${label}${hasAvatar ? ', with picture' : ''}`,
    send: 'Send message',
    stop: 'Stop the reply',
    refresh: 'Refresh the list',
    settings: 'Open settings',
    newSession: 'Create a new session',
    expandDetails: 'Show the details of this call',
    collapseDetails: 'Hide the details of this call',
    expandReasoning: "Show the agent's thinking",
    collapseReasoning: "Hide the agent's thinking",
    pagePrev: 'Previous page',
    pageNext: 'Next page',
    toolFailed: 'the call failed',
    surface: (label: string) => `Connection type: ${label}`,
    exportLog: 'Export the support log',
  },

  connect: {
    title: 'Connect',
    open: 'Set up the connection',
    intro: 'Personae talks to hermes-serve.service — the Hermes dashboard (profiles, sessions, plugins), port 9119. It gives you your profiles and their sessions.',
    step1: '1 · Service',
    step2: '2 · Sign in',
    step3: '3 · Check',
    addressLabel: 'Dashboard address',
    suggestions: 'Addresses this phone already knows:',
    probe: 'Check this address',
    probing: 'Checking…',
    isDashboard: (version: string, auth: boolean) =>
      `✓ hermes-serve.service answered — Hermes ${version || '?'}${auth ? ', sign-in required' : ', no sign-in needed'}.`,
    isGateway:
      'That address is hermes-gateway.service (messaging bridges: Telegram/WhatsApp) — it has no profiles and no sessions. The dashboard is :9119.',
    useDashboardPort: (url: string) => `Use ${url} instead`,
    refused: 'Nothing answered at that address. Is hermes-serve.service running and reachable from this phone?',
    tls: 'That address wants a secure connection (https://). Change the address to start with https://.',
    other: (status: number) => `Something answered with HTTP ${status}, but it is not the Hermes dashboard.`,
    systemdHelp: 'On the computer, these commands show and start the dashboard service (it must listen on 0.0.0.0, or be reachable over the tailnet):',
    copy: 'Copy',
    copied: 'Copied',
    pairBrowser: 'Pair this phone (sign in)',
    pairQr: 'Scan QR code',
    pairHelp: 'Sign in to the dashboard once; the phone receives its own key. Nothing to type or copy.',
    pasteLink: 'Or paste a personae:// link',
    pasteGo: 'Use link',
    advancedKey: 'Advanced: paste a bearer key instead',
    noPairing: 'This dashboard has no phone pairing (plugin personae-mobile-auth missing). Paste a key under Advanced.',
    verifying: 'Checking the new key…',
    found: (n: number) => `${n} profile${n === 1 ? '' : 's'} found`,
    verifyFailed: (what: string) => `Paired, but the check failed: ${what}`,
    deviceLabel: (label: string) => `This phone: ${label}`,
    revoke: 'Revoke this device',
    revoked: 'This device was revoked. Pair again to reconnect.',
    cancelled: 'Pairing cancelled.',
    failUsed: 'That pairing code was already used. Make a new one on the dashboard (/pair).',
    failExpired: 'That pairing code expired (it lasts 5 minutes). Make a new one on the dashboard.',
    failUnknown: 'The dashboard does not know that code. Make a new one on the dashboard.',
    failRate: 'Too many attempts. Wait a minute and try again.',
    failNetwork: 'Could not reach the dashboard to finish pairing.',
    failServer: (status: number) => `The dashboard refused the pairing (HTTP ${status}).`,
    badLink: 'That is not a Personae pairing link.',
    scanTitle: 'Point the camera at the QR code on the dashboard’s /pair page',
    cameraDenied: 'Camera permission is needed to scan the QR code.',
    grantCamera: 'Allow camera',
    done: 'Done',
    healed: (from: string, to: string) =>
      `Fixed the address: ${from} is the messaging gateway, not the dashboard — now using ${to}.`,
    healedSurface: 'Fixed the connection type: port 9119 is the dashboard.',
    dismiss: 'OK',
    syncOn: 'Groups, sort and colours sync with the desktop.',
    syncOff: 'This dashboard has no shared-layout store; groups stay on this phone.',
  },

  // ── notifications (0.8.0 H): device-side, and never called "push" ──────
  notify: {
    title: 'Notifications',
    help: 'The app tells you when a session reaches a checkpoint while the app is open. This is not push: nothing is sent from a server, and it does not work with the app closed.',
    master: 'Warn me about checkpoints',
    masterHelp: 'Off by default. Nothing is asked for and nothing polls until you turn this on.',
    waiting: 'Waiting on me',
    waitingHelp: 'A session asked a question and is blocked until you answer.',
    finished: 'Finished',
    finishedHelp: 'A session finished its turn.',
    waitingUnavailable:
      'This connection does not report whether a session is waiting, so this cannot be used here.',
    permission: 'Permission',
    permissionAsk: 'Allow notifications',
    permissionAsking: 'Asking…',
    permissionDenied:
      'Notifications are blocked for Personae. Open Android Settings → Apps → Personae → Notifications to allow them.',
    granted: 'Allowed',
    denied: 'Blocked',
    notAsked: 'Not asked yet',
    waitingTitle: 'Waiting on you',
    finishedTitle: 'Session finished',
    waitingBody: (name: string) => `${name} is waiting for your answer.`,
    finishedBody: (name: string) => `${name} finished. Tap to open it.`,
    activityBody: (name: string) => `${name} has new activity. Tap to open it.`,
    channelName: 'Session checkpoints',
    channelHelp: 'Waiting and finished checkpoints from your sessions.',
  },

  common: {
    back: 'Back',
    close: 'Close',
    unknown: '—',
    yes: 'Yes',
    no: 'No',
  },
};

export type Strings = typeof en;

/**
 * 0.9.1 §1.4 / §3.3 — THE PT TABLE IS NARROWER THAN EN, ON PURPOSE, AND FOR THE FIRST TIME.
 *
 * the user's rule for new strings is "an EN entry only", and the PT table is to be left in place,
 * unreachable, rather than extended (writing PT entries for the four new labels) or deleted. So these
 * six keys — the four Display-session-type labels and their help sentences — exist in EN and NOT in PT,
 * and this list is the ONLY place that asymmetry is declared.
 *
 * `pt` is still typed against `Strings` MINUS exactly these keys, so a pre-existing translation cannot
 * silently lose a key, and the suite asserts this list is exactly the EN-only set (the asymmetry cannot
 * grow quietly).
 */
export const EN_ONLY_SETTINGS_KEYS = [
  'typeCron',
  'typeCronHelp',
  'typeWebhook',
  'typeWebhookHelp',
  'typeOneshot',
  'typeOneshotHelp',
  // 0.10.0 S0-S5 — the Gateway Settings / connection-wizard strings. Same rule as 0.9.1 (§1.4): the
  // EN entry is written, the PT table is left in place, unreachable, and never extended. The whole
  // new surface lives under `t.settings.*` because that is the ONE group this list can narrow (see
  // `PtStrings` below) — a new top-level group would have to be translated to compile.
  'gwKindLocal',
  'gwKindRemote',
  'gwConnectionsTitle',
  'gwConnectionsHelp',
  'gwStatusTitle',
  'gwStatusHelp',
  'gwPickOne',
  'gwKindsTitle',
  'gwKindsHelp',
  'gwWizardButton',
  'gwWizardHelp',
  'gwFieldOrigin',
  'gwFieldRole',
  'gwFieldSecurity',
  'gwFieldSurface',
  'gwFieldServer',
  'gwFieldDevice',
  'gwFieldLastSeen',
  'gwUnknown',
  'gwNone',
  'gwNoDevice',
  'gwNever',
] as const;

type EnOnlySettingsKey = (typeof EN_ONLY_SETTINGS_KEYS)[number];
type PtStrings = Omit<Strings, 'settings'> & { settings: Omit<Strings['settings'], EnOnlySettingsKey> };

/** Portuguese (PT-PT): typed against the English table, so a missing or extra key fails typecheck. */
const pt: PtStrings = {
  appName: 'Personae',
  loading: 'A carregar…',
  retry: 'Tentar de novo',

  roster: {
    title: 'Personae',
    profiles: 'Perfis',
    primary: 'Principal',
    allProfiles: 'Tudo',
    sessions: 'Sessões',
    sessionsOf: (name: string) => `Sessões · ${name}`,
    emptyTitle: 'Ainda não há sessões',
    emptyBody: 'Quando este perfil tiver sessões, elas aparecem aqui.',
    newSession: 'Nova sessão',
    newSessionTitle: 'Nova sessão',
    newSessionPlaceholder: 'Título da sessão (opcional)',
    create: 'Criar',
    cancel: 'Cancelar',
    open: 'Abrir',
    openSettings: 'Definições',
    notConfiguredTitle: 'Falta configurar',
    notConfiguredBody: 'Indica o endereço do gateway e a chave de API em Definições para começar.',
    page: (cur: number, total: number, from: number, to: number, all: number) =>
      `Página ${cur} de ${total} · ${from}–${to} de ${all}`,
    prev: 'Anterior',
    next: 'Seguinte',
    newBadge: (n: number) => (n > 0 ? `${n} nova${n === 1 ? '' : 's'}` : ''),
    newTag: 'nova',
    messages: (n: number) => `${n} mensage${n === 1 ? 'm' : 'ns'}`,

    // ── the roster proper (0.5.0): a vertical list of faces that expand in place ──
    searchPlaceholder: 'Procurar perfis e conversas…',
    searchClear: 'Limpar',
    searchResults: (n: number) => (n === 1 ? '1 resultado' : `${n} resultados`),
    searchEmpty: 'Nada encontrado. Tenta outra palavra.',
    searchBodyHint: 'Inclui o texto das mensagens.',
    expandAll: 'Abrir todos',
    collapseAll: 'Fechar todos',
    automatic: 'Automático',
    automaticCount: (n: number) => (n === 1 ? '1 execução automática' : `${n} execuções automáticas`),
    automaticHelp:
      'Execuções de tarefas agendadas. Não são conversas; ficam aqui só para poderes vê-las.',
    // ── que tipos de sessão a lista mostra (0.8.0 D) ──────────────────────
    types: {
      noneTitle: 'Nenhum tipo de sessão está selecionado',
      noneBody: 'Assinala pelo menos um tipo de sessão nas Definições para ver sessões aqui.',
      noneAction: 'Abrir definições',
      hidden: (n: number) =>
        n === 1
          ? '1 execução automática está escondida — liga as execuções automáticas nas Definições.'
          : `${n} execuções automáticas estão escondidas — liga as execuções automáticas nas Definições.`,
    },
    // ── 0.9.0 E: seleção múltipla, o modelo do WhatsApp ──
    selection: {
      count: (n: number) => `${n} selecionadas`,
      selectAll: 'Selecionar tudo',
      clear: 'Limpar',
      close: 'Fechar',
      archive: 'Arquivar',
      delete: 'Apagar',
      done: 'Concluir',
      apropos: 'Apropos',
      deleteConfirm: (n: number) =>
        `Apagar ${n === 1 ? '1 sessão' : `${n} sessões`}? Isto não pode ser anulado.`,
      partial: (failed: number, total: number) => `${failed} de ${total} não funcionaram.`,
    },

    // ── 0.9.0 C: grupos de SESSÕES criados pelo utilizador (os Groups do desktop) ──
    sessionGroups: {
      toggle: (name: string, count: number) => `${name}, ${count} ${count === 1 ? 'sessão' : 'sessões'}`,
      newTitle: 'Novo grupo',
      namePlaceholder: 'Nome do grupo',
      create: 'Criar',
      rename: 'Renomear grupo',
      delete: 'Apagar grupo',
      deleteConfirm: (name: string) =>
        `Apagar o grupo "${name}"? As sessões lá dentro NÃO são apagadas — voltam para a lista.`,
      moveUp: 'Subir',
      moveDown: 'Descer',
      fileInto: 'Meter num grupo',
      removeFrom: 'Tirar do grupo',
      none: 'Sem grupo',
      filed: (name: string) => `Metida em "${name}".`,
      ungrouped: 'Sem grupo',
      empty: 'Grupo vazio — mantém premida uma sessão para a meter aqui.',
    },

    // ── o swipe numa linha de sessão (0.8.0 E): rótulos curtos — vivem em botões de 76 dp ──
    swipe: {
      archive: 'Arquivar',
      delete: 'Apagar',
      confirm: 'Confirmar',
      confirmDelete: 'Toca outra vez para apagar de vez',
      confirmCancel: 'Cancelar',
      a11yHint: 'Desliza para a esquerda para arquivar e apagar.',
    },
    noSessions: 'Sem conversas neste perfil.',
    profileErrorTitle: 'Não foi possível ler a lista de perfis',
    profileErrorBody:
      'O servidor respondeu, mas não deu a lista de perfis. Isto não é o mesmo que "não há perfis" — vê o erro abaixo e o registo de diagnóstico.',
    surfaceNoProfiles:
      'Esta ligação é a API do gateway (:9222), que não tem lista de perfis. Para ver o conjunto de perfis, muda em Definições para Dashboard (:9119).',

    groups: {
      title: 'Grupos',
      ungrouped: 'Sem grupo',
      new: 'Novo grupo',
      namePlaceholder: 'Nome do grupo',
      create: 'Criar grupo',
      rename: 'Mudar o nome',
      renamePrompt: 'Nome do grupo',
      delete: 'Apagar grupo',
      deleteConfirm: (name: string) =>
        `Apagar o grupo "${name}"? As conversas não são tocadas: os perfis voltam para «Sem grupo».`,
      empty: 'Grupo vazio. Mantém premido um perfil e escolhe «Mover para grupo» para o pôr aqui.',
      assign: 'Mover para grupo',
      assignment: (name: string) => `Mover para «${name}»`,
      remove: 'Tirar do grupo',
      help: 'Agrupa perfis com um nome. Apagar um grupo nunca apaga conversas.',
    },

    menu: {
      title: 'Ações',
      newSession: 'Nova sessão',
      rename: 'Mudar o nome…',
      renamePrompt: 'Novo nome',
      localOnly: 'só neste telefone',
      colour: 'Cor',
      colourNone: 'Sem cor',
      hide: 'Esconder perfil',
      // ── 0.9.0 D: o inventário do desktop, verbo a verbo ──
      select: 'Selecionar',
      openHere: 'Abrir',
      openWindow: 'Nova janela',
      openTab: 'Novo separador',
      sessionMenu: 'Sessão',
      markUnread: 'Marcar como não lida',
      branch: 'Ramificar',
      branchFailed: 'O gateway não devolveu uma sessão nova.',
      exportSession: 'Exportar…',
      hideSession: 'Esconder da Personae',
      unhideSession: 'Mostrar na Personae',
      apropos: 'Apropos (Sobre o tema, beta)',
      aproposSession: 'Desta sessão',
      aproposGroup: 'Criar grupo',
      aproposGroupHeading: 'Apropos este grupo (beta)',
      newSessionGroup: 'Novo grupo de sessões',
      moveToGroup: 'Mover para grupo',
      ungroupedPick: 'Sem grupo',
      project: 'Atribuir a projeto',
      openNewest: 'Abrir a sessão mais recente',
      moveUp: 'Subir',
      moveDown: 'Descer',
      unhide: 'Mostrar perfil',
      archiveAll: 'Arquivar todas as conversas',
      archiveAllConfirm: (label: string) =>
        `Arquivar todas as conversas de ${label}? Nada é apagado — ficam arquivadas no servidor.`,
      open: 'Abrir',
      copyId: 'Copiar identificador',
      copied: 'Identificador copiado.',
      sessionColour: 'Cor da conversa',
      archive: 'Arquivar conversa',
      deleteSession: 'Apagar conversa',
      deleteSessionConfirm: (title: string) => `Apagar a conversa "${title}"? Isto não se desfaz.`,
      deleted: 'Conversa apagada.',
      group: 'Grupo',
      sort: 'Ordenar',
      sortActivity: 'Por atividade',
      sortName: 'Por nome',
      sortSessions: 'Por nº de conversas',
      cancel: 'Cancelar',
    },

    lights: {
      waiting: 'À espera de ti',
      unread: 'Por ler',
      idle: 'Nada pendente',
      fresh: (n: number) => (n === 1 ? '1 nova desde a última visita' : `${n} novas desde a última visita`),
    },
  },

  thread: {
    // ── 0.9.0 G: anexos, a forma do WhatsApp ──
    attach: {
      add: 'Adicionar anexo',
      camera: 'Tirar fotografia',
      clipboard: 'Colar uma imagem',
      document: 'Enviar ficheiro',
      documentReason:
        'Escolher um ficheiro deste telefone precisa de um seletor de ficheiros que ainda não existe. As imagens já funcionam.',
      capture: 'Tirar a fotografia',
      captureFailed: 'A câmara não devolveu nenhuma imagem.',
      cameraDenied: 'A permissão da câmara foi recusada, por isso não é possível tirar fotografia.',
      clipboardEmpty: 'Não há nenhuma imagem na área de transferência.',
      clipboardFailed: (detail: string) => `Não foi possível ler a área de transferência: ${detail}`,
      refused: (name: string, reason: string) => `${name} não foi adicionado. ${reason}`,
      remove: 'Remover',
      imageLabel: 'Imagem anexada',
    },
    // ── 0.9.0 H: mensagens de voz ──
    voice: {
      hold: 'Manter premido para gravar uma mensagem de voz',
      slideToCancel: 'Desliza para a esquerda para cancelar, larga para guardar',
      releaseToCancel: 'Larga para cancelar',
      cancelled: 'A mensagem de voz foi cancelada.',
      tooShort: 'Demasiado curta — mantém premido um pouco mais para enviar uma mensagem de voz.',
      permissionDenied: 'A permissão do microfone foi recusada, por isso não é possível gravar.',
      recordFailed: (detail: string) => `A gravação falhou: ${detail}`,
      playback: (name: string) => `Mensagem de voz ${name}`,
      sending: 'Mensagem de voz',
    },
    you: 'Tu',
    agent: 'Agente',
    tools: (n: number) => `${n} chamada${n === 1 ? '' : 's'} a ferramentas`,
    showTools: 'Ver detalhes',
    hideTools: 'Esconder detalhes',
    reasoning: 'Pensamento',
    toolArgs: 'Argumentos',
    toolResult: 'Resultado',
    toolNoResult: 'sem resultado',
    toolFailed: 'falhou',
    orphanTool: 'resultado sem chamada correspondente',
    liveActivity: 'Atividade em direto',
    liveToolDone: 'concluída',
    liveToolRunning: 'a correr…',
    composerPlaceholder: 'Escreve uma mensagem…',
    send: 'Enviar',
    stop: 'Parar',
    thinking: 'A pensar…',
    historical: 'histórico',
    streamed: 'em direto',
    emptyThread: 'Sem mensagens nesta sessão. Escreve a primeira.',
    stopped: 'Resposta parada. O texto recebido ficou guardado.',
    fellBack: 'O modo em direto falhou; a resposta foi pedida novamente em bloco.',
    truncated: (n: number) => `(+${n} caracteres)`,
  },

  plus: {
    title: 'Novo',
    newGroup: 'Novo grupo',
    newProfile: 'Novo perfil',
    newSession: 'Nova sessão',
    pickProfile: 'A que perfil pertence?',
    profileName: 'Nome do perfil',
    profileNamePlaceholder: 'ex.: investigacao',
    create: 'Criar',
    created: (name: string) => `Perfil "${name}" criado.`,
    createRefused: (reason: string) => `Este telemóvel não pode criar perfis: ${reason}`,
    createUnavailable: 'Só na ligação ao Dashboard.',
    invalidName: 'Esse nome não pode ser usado num perfil.',
  },

  settings: {
    title: 'Definições',
    surface: 'Tipo de ligação',
    surfaceHelp:
      'Só há uma coisa obrigatória: o tipo de ligação tem de ser «Dashboard (:9119)» e a credencial tem de ser o bearer da app. A API do gateway (:9222) continua a funcionar, mas não tem perfis nem grupos.',
    surfaceCheckOk: 'Dashboard (:9119) + bearer — está preenchido. Usa «Testar ligação» para confirmar.',
    surfaceCheckPending:
      'Falta escolher «Dashboard (:9119)» ou preencher a credencial (o bearer). É o único par obrigatório.',
    gatewayNoProfiles:
      'A API do gateway (:9222) não tem lista de perfis: o roster fica sem perfis, sem grupos e sem conversas por perfil. Muda para «Dashboard (:9119)» para ver o conjunto todo.',
    baseUrl: 'Endereço do servidor',
    baseUrlHelp: 'Ex.: http://10.0.0.5:9119',
    baseUrlHelpGateway: 'Ex.: http://10.0.0.5:9222',
    // ── tipos de sessão (0.8.0 D): o que a lista de sessões mostra ───────
    sessionTypes: 'Tipos de sessão',
    sessionTypesHelp: 'Escolhe o que a lista de sessões mostra. Podes mudar isto a qualquer altura.',
    typeSessions: 'Sessões',
    typeSessionsHelp: 'Conversas que tens com um perfil.',
    typeAutomatic: 'Execuções automáticas (cron, webhooks)',
    typeAutomaticHelp: 'Tarefas agendadas que correram sozinhas. Não são conversas.',
    typeNoneWarning: 'Nenhum tipo está assinalado, por isso a lista de sessões fica vazia. Assinala um para ver sessões.',
    profilesFound: 'perfis encontrados',
    logTitle: 'Registo de diagnóstico',
    logHelp:
      'Um ficheiro .txt com o que a app tentou e falhou. Nada é enviado para fora: só é partilhado quando carregas no botão.',
    logPlaceholder: 'Escreve aqui o que se passou (opcional)…',
    logExport: 'Partilhar registo',
    logClear: 'Limpar',
    logShared: 'Registo criado e enviado para a partilha.',
    logCleared: 'Registo limpo.',
    logFailed: 'Não foi possível partilhar o registo.',
    apiKey: 'Chave de API',
    apiKeyHelp: 'Fica guardada no armazenamento seguro do telefone. Nunca sai daqui.',
    apiKeySet: 'guardada',
    apiKeyUnset: 'não definida',
    profiles: 'Perfis extra (prefixo)',
    profilesHelp: 'Um nome por linha. Cada um é servido em /p/<perfil>/.',
    model: 'Modelo (opcional)',
    modelHelp: 'Vazio usa o modelo por omissão do gateway.',
    effective: 'Em uso agora',
    clear: 'Limpar',
    saved: 'Guardado',
    savedKey: 'Chave guardada',
    clearKey: 'Apagar chave',
    clearKeyConfirm: 'Apagar a chave de API guardada neste telefone?',
    testConnection: 'Testar ligação',
    testing: 'A testar…',
    testOk: (v: string) => `Ligação OK · versão ${v}`,
    testFail: 'Falhou',
    autoSave: 'Cada campo é guardado sozinho.',
    showKey: 'Mostrar',
    hideKey: 'Esconder',
    valueSet: 'definido',
    valueUnset: 'vazio',
    surfaceDashboard: 'Dashboard (:9119)',
    surfaceGateway: 'API do gateway (:9222)',
    keyChars: (n: number) => `${n} caracteres`,
    keyPlaceholderDashboard: 'Bearer do dashboard',
    keyPlaceholderGateway: 'API_SERVER_KEY',
    modelDefault: 'modelo por omissão do gateway',
    ignored: (list: string) => `Ignorado: ${list}`,
    logLines: (n: number) => `${n} linhas`,
    logFileName: 'personae-registo.txt',
    language: 'Língua / Language',
    languageHelp: 'Muda logo. Também define a língua do registo de diagnóstico.',
    languageEnglish: 'English',
    languagePortuguese: 'Português',
    advanced: 'Avançado',
    advancedHelp:
      'Tipo de ligação, endereço, chave, rotas, detalhes do tailnet, estado e o registo. Nada aqui é preciso para o uso normal.',
    advancedShow: 'Mostrar definições avançadas',
    advancedHide: 'Esconder definições avançadas',
    // ── 0.9.0 B: Settings as a page of rows ──────────────────────────────
    pagesTitle: 'Definições',
    pagesHelp: 'Cada linha abre a sua própria página. Nada abaixo mudou.',
    pages: {
      agentTitle: 'Preferências do Agente',
      agentHelp: 'A língua desta app e que tipos de sessão aparecem na lista.',
      notificationsTitle: 'Notificações',
      notificationsHelp: 'Que pontos de controlo avisam, e a permissão do telefone que precisam.',
      gatewayTitle: 'Definições do Gateway',
      gatewayHelp: 'Como este telefone chega ao gateway: emparelhamento, Tailscale, endereço e chave.',
      advancedTitle: 'Avançado',
      advancedHelp: 'Tipo de ligação, endereço, chave, rotas, interior do tailnet, estado e registo.',
    },
    scopeTitle: 'O que sincroniza',
    scopePortable: 'Sincroniza',
    scopeDeviceLocal: 'Só neste telefone',
    scopeMixed: 'Sincroniza em parte',
    scopeHelp:
      'Cada definição ou é partilhada com o desktop, ou fica neste telefone. Um endereço de gateway ou uma chave nunca são partilhados: o desktop liga a si próprio e este telefone liga ao tailnet.',
    scopeOpen: 'Ver o que é partilhado',
  },

  routes: {
    title: 'Rotas',
    help:
      'O mesmo gateway pode ser alcançado por vários caminhos. A app testa-os por ordem e usa o primeiro que responder.',
    empty: 'Ainda não há rotas. Escreve uma abaixo.',
    add: 'Adicionar rota',
    placeholder: 'http://10.0.0.5:9222',
    roleLan: 'Rede local',
    roleTailscale: 'Tailscale',
    rolePublic: 'Internet (público)',
    customRole: (role: string) => `Personalizado (${role})`,
    inferred: 'Deduzido do endereço',
    invalid: 'Endereço inválido',
    problemBadUrl: 'Endereço inválido — tem de começar por http:// ou https://',
    problemPublicHttp:
      'Um endereço público tem de ser https://. Este não será usado enquanto for http://.',
    problemNeedsAck:
      'Rota http:// numa rede privada: não tem TLS de aplicação. Autoriza em baixo para a usar.',
    moveUp: 'Subir',
    moveDown: 'Descer',
    remove: 'Remover',
    removeConfirm: (url: string) => `Remover a rota ${url}?`,
    priorityLabel: (n: number) => `prioridade ${n}`,
    ackTitle: 'Autorizar rotas http:// fora do loopback',
    ackHelp:
      'Rota privada sem TLS de aplicação. O tráfego continua cifrado pelo WireGuard do Tailscale quando o endereço é do tailnet.',
    preferredTitle: 'Rota preferida',
    preferredAuto: 'Automático',
    preferredHelp: 'Automático escolhe sempre pela ordem de prioridade.',
    secTailscaleTls: 'TLS de aplicação (certificado .ts.net)',
    secTailscaleWireguard:
      'Sem TLS de aplicação — cifrado pelo WireGuard do Tailscale',
    secLocalTls: 'TLS de aplicação',
    secLocalPlain: 'Sem TLS — rede local privada',
    secPublicTls: 'TLS de aplicação',
    secPublicPlain: 'Sem TLS — endereço público (só https:// é aceite)',
  },

  connectivity: {
    title: 'Ligação',
    tailscaleInstalled: 'Tailscale instalado',
    autoConnect: 'Ligar o túnel automaticamente ao abrir',
    autoConnectHelp:
      'Envia o pedido de ligação à app Tailscale ao abrir e ao voltar a primeiro plano.',
    tailscalePackage: 'Pacote do Tailscale',
    tailscalePackageHelp: 'Só é preciso mudar se usares uma versão modificada da app.',
    connectDeadline: 'Espera máxima (s)',
    probeTimeout: 'Tempo por tentativa (s)',
    openOnFailure: 'Abrir a Tailscale quando a ligação falhar',
    diagnosticsTitle: 'Estado da ligação',
    diagInstalled: 'Tailscale instalado',
    diagTunnel: 'Túnel',
    diagRoute: 'Rota escolhida',
    diagGateway: 'Gateway a responder',
    diagEverWorked: 'Já alguma vez ligou',
    diagLastError: 'Último erro',
    diagPinBypassed: (role: string) =>
      `A rota preferida (${role}) não respondeu; foi usada outra.`,
    yes: 'Sim',
    no: 'Não',
    unknown: 'Por saber',
    tunnelUp: 'Ligado',
    tunnelDown: 'Desligado',
    tunnelProbing: 'A ligar…',
    noneChosen: 'Nenhuma',
    diagTrigger: 'Último pedido ao túnel',
    diagVpnHint: 'A rede ativa tem VPN — indício, não prova',
    diagHealthCaveat:
      'O /v1/health a responder prova que a rota chega ao gateway; não prova que uma conversa vai funcionar.',
    diagNotAvailable: 'Só no Android',
    recheck: 'Verificar agora',
    setupIncomplete:
      'O túnel não ficou pronto dentro do tempo. Abre a Tailscale, liga-a, e volta aqui.',
    openTailscale: 'Abrir Tailscale',
    notInstalled:
      'A app Tailscale não está instalada neste telefone. Instala-a ou usa uma rota de rede local.',
    permanentKey:
      'A chave de API foi recusada. Corrige a chave em Definições — não vale a pena tentar de novo.',
    iosNote:
      'No iPhone não é possível ligar a Tailscale a partir daqui: não existe este mecanismo entre apps. Liga o "On-Demand" nas Definições da Tailscale e a app liga-se sozinha a seguir.',
    probeNoHostPort: 'endereço sem host ou porta',
    probeNoAnswer: (hostPort: string, ms: number) => `${hostPort} não respondeu em ${ms} ms`,
    probeOpenNoReply: 'a ligação abriu mas não houve resposta',
    triggerSent: 'enviado',
    triggerNotSent: 'não enviado',
    triggerAutoOff: 'automático desligado',
    triggerUnavailable: 'indisponível nesta plataforma',
    logIn: 'Entrar no Tailscale',
    logInHelp:
      'Abre a aplicação Tailscale. Entra lá e liga o túnel, depois volta aqui — nenhuma aplicação consegue entrar por ti.',
    chooseDevice: 'Escolher dispositivo',
    chooseDeviceHelp:
      'Mostra as máquinas que este servidor vê no tailnet e acrescenta a que escolheres como rota, depois de confirmar que responde.',
    devicesTitle: 'Dispositivos no tailnet',
    devicesLoading: 'A ler dispositivos…',
    devicesRetry: 'Ler de novo',
    devicesUnavailable: (reason: string) =>
      `Não foi possível ler a lista de dispositivos (${reason}). Escreve o endereço em Avançado.`,
    devicesEmpty: 'Não há outra máquina visível no tailnet agora. Escreve o endereço em Avançado.',
    peerSelf: 'este servidor',
    peerOnline: 'ligado',
    peerOffline: 'desligado',
    peerAdded: (name: string, address: string) => `${name} acrescentado como rota (${address}).`,
    peerNotAnswering: (name: string, address: string) => `${name} não respondeu em ${address}. Não foi acrescentado nada.`,
    peerAlreadyRoute: (address: string) => `${address} já é uma rota.`,
  },

  errors: {
    noBaseUrl: 'Falta o endereço do gateway. Abre Definições e escreve-o.',
    badBaseUrl: (v: string) => `O endereço "${v}" não é válido. Tem de começar por http:// ou https://`,
    noKey: 'Falta a chave de API. Abre Definições e escreve-a.',
    unauthorized:
      'A chave de API foi recusada pelo gateway (401). Confirma a chave em Definições.',
    unauthorizedProfile: (p: string) =>
      `A chave de API foi recusada pelo gateway (401) para o perfil "${p}". Confirma a chave e o nome do perfil.`,
    network: (detail: string) =>
      `Não foi possível contactar o gateway. Verifica o endereço e se estás na mesma rede. (${detail})`,
    timeout: (sec: number) => `O gateway não respondeu em ${sec} s.`,
    notFound: (what: string) => `${what} não existe no gateway (404).`,
    sessionGone: 'Esta sessão já não existe no gateway.',
    server: (status: number, detail: string) => `Erro no gateway (${status}): ${detail}`,
    badJson: 'A resposta do gateway não é JSON válido.',
    badStream: 'A transmissão em direto veio em formato inválido.',
    missingMessage: "Falta o campo 'message'.",
    streamDropped: 'A transmissão em direto caiu antes do fim.',
    sessionNoId: 'sessão sem id',
    turnFailed: 'erro no turno',
    streamFailed: 'erro na transmissão',
    rpcFailed: 'erro RPC',
    internal: 'erro interno',
    archiveUnsupported: 'arquivar não é suportado nesta ligação',
    profileCreateUnsupported: 'criar perfis não é suportado nesta ligação',
    deleteUnsupported: 'apagar não é suportado nesta ligação',
    renameUnsupported: 'renomear não é suportado nesta ligação',
    // 0.9.0 D — os dois verbos de sessão que a superfície antiga não alcança.
    flagsUnsupported: 'esconder e marcar como não lida não é suportado nesta ligação',
    attachUnsupported: 'enviar imagens não é suportado nesta ligação',
    branchUnsupported: 'ramificar uma sessão não é suportado nesta ligação',
    ticketMissing: 'ticket ausente',
    resource: 'O recurso',
  },

  status: {
    ok: 'A responder',
    degraded: 'Instável',
    down: 'Sem resposta',
    unknown: 'Por testar',
    auth: 'Chave recusada',
  },

  time: {
    justNow: 'agora mesmo',
    minutesAgo: (n: number) => `há ${n} min`,
    hoursAgo: (n: number) => `há ${n} h`,
    daysAgo: (n: number) => `há ${n} d`,
  },

  /** The exported support log (header lines + the per-call lines written while the app runs). */
  log: {
    docTitle: 'Personae — registo de diagnóstico',
    generated: (stamp: string) => `Gerado: ${stamp}`,
    userNote: 'O que se passou (escrito por ti):',
    context: 'Contexto',
    connection: (surface: string, url: string) => `Ligação: ${surface} · ${url}`,
    noAddress: 'sem endereço',
    activeRoute: (url: string) => `Rota em uso: ${url}`,
    candidateRoutes: 'Rotas candidatas (por prioridade):',
    recentFailures: 'Últimas falhas:',
    device: (os: string) => `Dispositivo: ${os}`,
    notAvailable: 'n/d',
    entries: (n: number) => `Registo (${n} linhas, mais antiga primeiro)`,
    empty: '(vazio)',
    redactionNote: 'Nota: cabeçalhos de autenticação, bilhetes e tokens são substituídos por [REDACTED].',
    attempt: (n: number) => ` (tentativa ${n})`,
    noResponse: 'sem resposta',
    took: (status: string, ms: number) => `${status} em ${ms} ms`,
    timedOut: (ms: number) => `tempo esgotado (${ms} ms)`,
    networkFailure: 'falha de rede',
    wsOpening: (url: string, ttl: number) => `a abrir /api/ws com um bilhete novo (${url}, ttl ${ttl} s)`,
    wsFailure: 'falha no WebSocket',
  },

  /**
   * Accessibility labels, PT-PT (F2): every icon-only control needs one, or it is unusable with a
   * screen reader. Kept apart from the visible copy so a label can be longer than a caption.
   */
  a11y: {
    avatar: (name: string) => `Fotografia de perfil de ${name}`,
    contact: (label: string, hasAvatar: boolean) =>
      `Perfil ${label}${hasAvatar ? ', com fotografia' : ''}`,
    send: 'Enviar mensagem',
    stop: 'Parar a resposta',
    refresh: 'Atualizar a lista',
    settings: 'Abrir definições',
    newSession: 'Criar uma sessão nova',
    expandDetails: 'Ver os detalhes desta chamada',
    collapseDetails: 'Esconder os detalhes desta chamada',
    expandReasoning: 'Ver o pensamento do agente',
    collapseReasoning: 'Esconder o pensamento do agente',
    pagePrev: 'Página anterior',
    pageNext: 'Página seguinte',
    toolFailed: 'a chamada falhou',
    surface: (label: string) => `Tipo de ligação: ${label}`,
    exportLog: 'Exportar o registo de diagnóstico',
  },

  connect: {
    title: 'Ligação',
    open: 'Configurar a ligação',
    intro: 'A Personae fala com o hermes-serve.service — o dashboard do Hermes (perfis, sessões, plugins), porta 9119. É ele que dá os perfis e as sessões.',
    step1: '1 · Serviço',
    step2: '2 · Entrar',
    step3: '3 · Verificar',
    addressLabel: 'Endereço do dashboard',
    suggestions: 'Endereços que este telefone já conhece:',
    probe: 'Verificar este endereço',
    probing: 'A verificar…',
    isDashboard: (version: string, auth: boolean) =>
      `✓ O hermes-serve.service respondeu — Hermes ${version || '?'}${auth ? ', pede início de sessão' : ', sem início de sessão'}.`,
    isGateway:
      'Esse endereço é o hermes-gateway.service (bridges de mensagens: Telegram/WhatsApp) — não tem perfis nem sessões. O dashboard é o :9119.',
    useDashboardPort: (url: string) => `Usar ${url}`,
    refused: 'Nada respondeu nesse endereço. O hermes-serve.service está a correr e acessível a partir deste telefone?',
    tls: 'Esse endereço pede ligação segura (https://). Muda o endereço para começar por https://.',
    other: (status: number) => `Algo respondeu com HTTP ${status}, mas não é o dashboard do Hermes.`,
    systemdHelp: 'No computador, estes comandos mostram e arrancam o serviço do dashboard (tem de escutar em 0.0.0.0, ou ser acessível pela tailnet):',
    copy: 'Copiar',
    copied: 'Copiado',
    pairBrowser: 'Emparelhar este telefone (entrar)',
    pairQr: 'Ler código QR',
    pairHelp: 'Entra uma vez no dashboard; o telefone recebe a sua própria chave. Nada para escrever ou copiar.',
    pasteLink: 'Ou cola uma ligação personae://',
    pasteGo: 'Usar ligação',
    advancedKey: 'Avançado: colar uma chave bearer',
    noPairing: 'Este dashboard não tem emparelhamento de telefones (falta o plugin personae-mobile-auth). Cola uma chave em Avançado.',
    verifying: 'A verificar a nova chave…',
    found: (n: number) => `${n} perfi${n === 1 ? 'l' : 's'} encontrado${n === 1 ? '' : 's'}`,
    verifyFailed: (what: string) => `Emparelhado, mas a verificação falhou: ${what}`,
    deviceLabel: (label: string) => `Este telefone: ${label}`,
    revoke: 'Revogar este dispositivo',
    revoked: 'Este dispositivo foi revogado. Emparelha de novo para voltar a ligar.',
    cancelled: 'Emparelhamento cancelado.',
    failUsed: 'Esse código já foi usado. Gera um novo no dashboard (/pair).',
    failExpired: 'Esse código expirou (dura 5 minutos). Gera um novo no dashboard.',
    failUnknown: 'O dashboard não conhece esse código. Gera um novo no dashboard.',
    failRate: 'Demasiadas tentativas. Espera um minuto e tenta de novo.',
    failNetwork: 'Não foi possível chegar ao dashboard para concluir o emparelhamento.',
    failServer: (status: number) => `O dashboard recusou o emparelhamento (HTTP ${status}).`,
    badLink: 'Isso não é uma ligação de emparelhamento da Personae.',
    scanTitle: 'Aponta a câmara para o código QR na página /pair do dashboard',
    cameraDenied: 'É preciso autorização para a câmara para ler o código QR.',
    grantCamera: 'Autorizar câmara',
    done: 'Concluído',
    healed: (from: string, to: string) =>
      `Endereço corrigido: ${from} é o gateway de mensagens, não o dashboard — agora uso ${to}.`,
    healedSurface: 'Tipo de ligação corrigido: a porta 9119 é o dashboard.',
    dismiss: 'OK',
    syncOn: 'Grupos, ordenação e cores sincronizam com o computador.',
    syncOff: 'Este dashboard não tem arquivo partilhado de layout; os grupos ficam neste telefone.',
  },

  // ── notificações (0.8.0 H): locais, nunca chamadas "push" ────────────
  notify: {
    title: 'Notificações',
    help: 'A app avisa quando uma sessão chega a um ponto de paragem enquanto está aberta. Isto não é push: nada é enviado de um servidor e não funciona com a app fechada.',
    master: 'Avisar-me dos pontos de paragem',
    masterHelp: 'Desligado por omissão. Nada é pedido e nada é consultado enquanto não ligares isto.',
    waiting: 'À espera de mim',
    waitingHelp: 'Uma sessão fez uma pergunta e está parada até responderes.',
    finished: 'Concluída',
    finishedHelp: 'Uma sessão terminou a sua vez.',
    waitingUnavailable:
      'Esta ligação não diz se uma sessão está à espera, por isso isto não pode ser usado aqui.',
    permission: 'Permissão',
    permissionAsk: 'Autorizar notificações',
    permissionAsking: 'A pedir…',
    permissionDenied:
      'As notificações estão bloqueadas para a Personae. Abre Definições do Android → Aplicações → Personae → Notificações para autorizar.',
    granted: 'Autorizadas',
    denied: 'Bloqueadas',
    notAsked: 'Ainda não pedidas',
    waitingTitle: 'À espera de ti',
    finishedTitle: 'Sessão concluída',
    waitingBody: (name: string) => `${name} está à espera da tua resposta.`,
    finishedBody: (name: string) => `${name} terminou. Toca para abrir.`,
    activityBody: (name: string) => `${name} tem atividade nova. Toca para abrir.`,
    channelName: 'Pontos de paragem das sessões',
    channelHelp: 'Pontos de paragem «à espera» e «concluída» das tuas sessões.',
  },

  common: {
    back: 'Voltar',
    close: 'Fechar',
    unknown: '—',
    yes: 'Sim',
    no: 'Não',
  },
};

/**
 * The tables, by language. PT is deliberately NARROWER than EN since 0.9.1 — it lacks exactly
 * `EN_ONLY_SETTINGS_KEYS` — so the values are widened to `Strings` here, in this one place. Nothing can
 * read the difference: the app's language is `DEFAULT_LANGUAGE` and no production module can change it
 * (0.9.1 S4.1), so PT is unreachable at runtime. The cast is the honest shape of "kept in place" rather
 * than "kept in sync", and the suite is where the asymmetry is measured.
 */
const tables: Record<Language, Strings> = { en, pt: pt as unknown as Strings };

let current: Language = DEFAULT_LANGUAGE;
const listeners = new Set<() => void>();

export function getLanguage(): Language {
  return current;
}

export function setLanguage(language: Language): void {
  const next = isLanguage(language) ? language : DEFAULT_LANGUAGE;
  if (next === current) return;
  current = next;
  for (const listener of Array.from(listeners)) listener();
}

export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Re-render the calling component whenever the language changes; returns the current language. */
export function useLanguage(): Language {
  return useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage);
}

/** The raw table for one language (tests, and anything that must not follow the live switch). */
export function stringsFor(language: Language): Strings {
  return tables[language];
}

/** Live string table: each top-level read resolves against the current language. */
export const t: Strings = new Proxy({} as Strings, {
  get: (_target, key) => (tables[current] as Record<string | symbol, unknown>)[key],
  has: (_target, key) => key in tables[current],
  ownKeys: () => Reflect.ownKeys(tables[current]),
  getOwnPropertyDescriptor: (_target, key) => {
    const value = (tables[current] as Record<string | symbol, unknown>)[key];
    return value === undefined ? undefined : { value, enumerable: true, configurable: true, writable: false };
  },
});
