import { useEffect, useState } from 'react';
import { Pressable, Text } from 'react-native';
import {
  notificationPermission,
  requestNotificationPermission,
  type NotificationPermission,
} from '../notifications/scheduler';
import { styles } from './ui';

/** Asks only when the person chooses to; reminders stay off until the OS permission is granted. */
export function NotificationSetting({ onGranted }: { onGranted: () => void }) {
  const [permission, setPermission] = useState<NotificationPermission | null>(
    null,
  );
  useEffect(() => {
    let active = true;
    void notificationPermission().then((value) => {
      if (active) setPermission(value);
    });
    return () => {
      active = false;
    };
  }, []);
  // Only the first ask is offered here; after the OS has answered, Today stays quiet.
  if (permission !== 'undetermined') return null;
  return (
    <Pressable
      accessibilityRole="button"
      hitSlop={10}
      onPress={() => {
        void requestNotificationPermission().then((value) => {
          setPermission(value);
          if (value === 'granted') onGranted();
        });
      }}
    >
      <Text
        style={[
          styles.muted,
          { textAlign: 'center', textDecorationLine: 'underline' },
        ]}
      >
        通知を受け取る
      </Text>
    </Pressable>
  );
}
