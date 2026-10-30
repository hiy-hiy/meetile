import { Platform } from 'react-native';
import { hasNativeModule } from '../native-available';
import { REMINDER_TEXT, type Reminder } from './plan';

type Notifications = typeof import('expo-notifications');
export type NotificationPermission =
  'granted' | 'denied' | 'undetermined' | 'unavailable';
const CHANNEL = 'reminders';

let loading: Promise<Notifications | null> | null = null;
/** Loaded lazily: an older development binary without the native module keeps working. */
function load(): Promise<Notifications | null> {
  // The package initializes these at import; all must exist in this binary.
  if (
    !hasNativeModule(
      'ExpoPushTokenManager',
      'ExpoNotificationScheduler',
      'ExpoNotificationPermissionsModule',
      'ExpoNotificationsHandlerModule',
    )
  )
    return Promise.resolve(null);
  return (loading ??= import('expo-notifications')
    .then(async (Notifications) => {
      Notifications.setNotificationHandler({
        handleNotification: () =>
          Promise.resolve({
            shouldShowBanner: true,
            shouldShowList: true,
            shouldPlaySound: false,
            shouldSetBadge: false,
          }),
      });
      if (Platform.OS === 'android')
        await Notifications.setNotificationChannelAsync(CHANNEL, {
          name: 'お知らせ',
          importance: Notifications.AndroidImportance.DEFAULT,
        });
      return Notifications;
    })
    .catch(() => null));
}

export async function notificationPermission(): Promise<NotificationPermission> {
  const Notifications = await load();
  if (!Notifications) return 'unavailable';
  try {
    const permission = await Notifications.getPermissionsAsync();
    // Android 13 reports "denied" before the first request; it can still be asked.
    return permission.status === Notifications.PermissionStatus.DENIED &&
      permission.canAskAgain
      ? 'undetermined'
      : permission.status;
  } catch {
    return 'unavailable';
  }
}
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  const Notifications = await load();
  if (!Notifications) return 'unavailable';
  try {
    const permission = await Notifications.requestPermissionsAsync();
    return permission.status === Notifications.PermissionStatus.DENIED &&
      permission.canAskAgain
      ? 'undetermined'
      : permission.status;
  } catch {
    return 'unavailable';
  }
}

/** Replaces every scheduled reminder; this app schedules nothing else. */
export async function applyReminders(plan: Reminder[]): Promise<void> {
  const Notifications = await load();
  if (!Notifications) return;
  if (
    (await Notifications.getPermissionsAsync()).status !==
    Notifications.PermissionStatus.GRANTED
  )
    return;
  await Notifications.cancelAllScheduledNotificationsAsync();
  for (const reminder of plan)
    await Notifications.scheduleNotificationAsync({
      identifier: `${reminder.kind}-${reminder.atMs}`,
      content: { ...REMINDER_TEXT[reminder.kind] },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: reminder.atMs,
        channelId: CHANNEL,
      },
    });
}
