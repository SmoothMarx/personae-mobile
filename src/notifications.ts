/**
 * The ONE module that talks to `expo-notifications` (0.8.0 H).
 *
 * These are DEVICE-SIDE LOCAL notifications. Nothing here contacts a server: the app's own poll (see
 * `src/logic/checkpoints.ts` and `src/logic/watcher.ts`) decides a checkpoint happened, and this
 * module turns that decision into a notification on this phone. Delivering one with the app closed
 * would need an FCM project, credentials and a sender on the gateway — 0.9.0's business.
 *
 * Everything testable lives in the pure modules; this file is deliberately thin, and the API shapes
 * below are read off the INSTALLED module's own types (expo-notifications 57.0.22), where SDK 57
 * replaced the single "show the alert" flag with `shouldShowBanner` + `shouldShowList`.
 */

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { t } from './i18n';
import { notificationFor, type CheckpointEvent, type PermissionState } from './logic/checkpoints';

/** The Android channel every checkpoint notification lands in. */
export const CHANNEL_ID = 'checkpoints';

/** Behaviour WHILE THE APP IS OPEN: show it, do not make a sound about it. */
export function installHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async (): Promise<Notifications.NotificationBehavior> => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}

/**
 * The Android channel. High importance so the notification appears as a heads-up rather than
 * silently in the drawer — the operator asked to be WARNED. Created once, on first use.
 */
export async function ensureChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: t.notify.channelName,
      description: t.notify.channelHelp,
      importance: Notifications.AndroidImportance.HIGH,
    });
  } catch {
    /* a missing channel must never break the roster: the notification just loses its grouping */
  }
}

/** The permission as it stands right now — never asks. */
export async function readPermission(): Promise<PermissionState> {
  try {
    return permissionOf(await Notifications.getPermissionsAsync());
  } catch {
    return 'not-asked';
  }
}

/**
 * Ask. Called ONLY from the moment the user turns the master switch on — never at cold start, which
 * is the whole point of the switch being off by default.
 */
export async function askPermission(): Promise<PermissionState> {
  try {
    return permissionOf(await Notifications.requestPermissionsAsync());
  } catch {
    return 'not-asked';
  }
}

function permissionOf(status: Notifications.NotificationPermissionsStatus): PermissionState {
  if (status.granted) return 'granted';
  const canAsk = (status as { canAskAgain?: boolean }).canAskAgain;
  if (canAsk === false) return 'denied';
  return 'not-asked';
}

/** Show one notification per checkpoint. Returns how many actually went out. */
export async function present(events: CheckpointEvent[]): Promise<number> {
  let shown = 0;
  for (const event of events) {
    const content = notificationFor(event);
    try {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: content.title,
          body: content.body,
          data: { ...content.data, url: `/thread/${event.sessionId}` },
        },
        // `null` = show it now. A trigger with a date would schedule it for later, which is not what
        // "the session just stopped" means.
        trigger: null,
      });
      shown += 1;
    } catch {
      /* one failed notification must not abort the others */
    }
  }
  return shown;
}

/**
 * Tapping a notification opens that session. `router.push('/thread/<id>')` — the response carries the
 * session id and the profile we put in `data`.
 */
export function onResponse(open: (sessionId: string, profile: string) => void): () => void {
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    const data = response?.notification?.request?.content?.data ?? {};
    const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
    const profile = typeof data.profile === 'string' ? data.profile : '';
    if (sessionId) open(sessionId, profile);
  });
  return () => {
    try {
      subscription.remove();
    } catch {
      /* already gone */
    }
  };
}
