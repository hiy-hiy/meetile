import type { ReactNode } from 'react';
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { colors } from '@puzzle-sns/design';
import wordmark from '../../assets/brand/meetile-wordmark.png';
export function Button({
  title,
  onPress,
  disabled = false,
  secondary = false,
  danger = false,
  compact = false,
  style,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
  /** Red tone for actions that cannot be undone. */
  danger?: boolean;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        compact && styles.compact,
        secondary ? styles.secondary : danger && styles.danger,
        pressed &&
          (secondary
            ? styles.secondaryPressed
            : danger
              ? styles.dangerPressed
              : styles.pressed),
        disabled && styles.disabled,
        style,
      ]}
    >
      <Text
        style={[
          styles.buttonText,
          compact && styles.compactText,
          secondary && styles.secondaryText,
          secondary && danger && styles.dangerText,
        ]}
      >
        {title}
      </Text>
    </Pressable>
  );
}
export function Checkbox({
  checked,
  label,
  onPress,
  disabled = false,
}: {
  checked: boolean;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={styles.check}
    >
      <View style={[styles.box, checked && styles.boxChecked]}>
        {checked && <Text style={styles.tick}>✓</Text>}
      </View>
      <Text style={[styles.body, { flex: 1 }]}>{label}</Text>
    </Pressable>
  );
}
/** Mutually exclusive options side by side, e.g. the age declaration. */
export function Choice<T extends string>({
  options,
  value,
  onChange,
  disabled = false,
}: {
  options: readonly (readonly [T, string])[];
  value: T | null;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <View accessibilityRole="radiogroup" style={styles.choice}>
      {options.map(([key, label]) => (
        <Pressable
          key={key}
          accessibilityRole="radio"
          accessibilityState={{ checked: value === key, disabled }}
          disabled={disabled}
          onPress={() => onChange(key)}
          style={[styles.option, value === key && styles.optionOn]}
        >
          <Text
            style={[styles.optionText, value === key && styles.optionOnText]}
          >
            {label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
/** A rounded status card: caution for safety/development warnings. */
export function Note({
  children,
  caution = false,
  alert = false,
}: {
  children: ReactNode;
  caution?: boolean;
  alert?: boolean;
}) {
  return (
    <View style={[styles.note, caution && styles.noteCaution]}>
      <Text
        accessibilityRole={alert ? 'alert' : undefined}
        style={[styles.body, caution && { color: colors.caution }]}
      >
        {children}
      </Text>
    </View>
  );
}
/** The Meetile wordmark, white on transparent, for the black ground (900×154 source). */
export function Wordmark({ width = 160 }: { width?: number }) {
  return (
    <Image
      source={wordmark}
      accessible
      accessibilityRole="image"
      accessibilityLabel="Meetile"
      style={{ width, height: (width * 154) / 900 }}
      resizeMode="contain"
    />
  );
}
const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
/** "2026-10-30" → 10月30日 / 金. The key is already the server's 4 a.m. day. */
export function dayParts(dayKey: string) {
  const [year = 0, month = 1, day = 1] = dayKey.split('-').map(Number);
  const weekday =
    weekdays[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return { year, date: `${month}月${day}日`, weekday: weekday ?? '' };
}
/** Large date with the weekday as a small pill. */
export function DayTitle({ dayKey }: { dayKey: string }) {
  const day = dayParts(dayKey);
  return (
    <View
      accessible
      accessibilityRole="header"
      accessibilityLabel={`${day.date}（${day.weekday}）`}
      style={[styles.row, { justifyContent: 'flex-start', gap: 10 }]}
    >
      <Text style={styles.title}>{day.date}</Text>
      <View style={styles.chip}>
        <Text style={styles.chipText}>{day.weekday}</Text>
      </View>
    </View>
  );
}
export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: 20, paddingVertical: 24, gap: 16 },
  display: {
    fontSize: 40,
    lineHeight: 48,
    fontWeight: '900',
    color: colors.text,
    letterSpacing: -1,
    fontVariant: ['tabular-nums'],
  },
  title: {
    fontSize: 28,
    lineHeight: 38,
    fontWeight: '900',
    color: colors.text,
    letterSpacing: -0.5,
  },
  heading: {
    fontSize: 18,
    lineHeight: 26,
    fontWeight: '800',
    color: colors.text,
  },
  body: { fontSize: 16, lineHeight: 25, color: colors.text },
  muted: { fontSize: 14, lineHeight: 21, color: colors.muted },
  input: {
    borderRadius: 18,
    paddingHorizontal: 18,
    paddingVertical: 15,
    fontSize: 17,
    color: colors.text,
    backgroundColor: colors.raised,
  },
  button: {
    backgroundColor: colors.white,
    borderRadius: 999,
    paddingVertical: 16,
    paddingHorizontal: 20,
    minHeight: 56,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { backgroundColor: '#D6D6D6' },
  compact: { minHeight: 46, paddingVertical: 11, paddingHorizontal: 16 },
  buttonText: {
    fontSize: 17,
    fontWeight: '800',
    color: colors.black,
    textAlign: 'center',
  },
  compactText: { fontSize: 15, fontWeight: '700' },
  secondary: { backgroundColor: colors.raised },
  secondaryPressed: { backgroundColor: colors.pressed },
  secondaryText: { color: colors.text },
  danger: { backgroundColor: colors.danger },
  dangerPressed: { backgroundColor: '#E36060' },
  dangerText: { color: colors.danger },
  disabled: { opacity: 0.35 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  chip: {
    backgroundColor: colors.raised,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  chipText: { fontSize: 15, fontWeight: '800', color: colors.text },
  check: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 48,
  },
  box: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    borderColor: '#5C5C5C',
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxChecked: { backgroundColor: colors.white, borderColor: colors.white },
  tick: {
    color: colors.black,
    fontSize: 15,
    fontWeight: '900',
    lineHeight: 18,
  },
  choice: { flexDirection: 'row', gap: 10 },
  option: {
    flex: 1,
    minHeight: 52,
    borderRadius: 999,
    backgroundColor: colors.raised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionOn: { backgroundColor: colors.white },
  optionText: { fontSize: 16, fontWeight: '700', color: colors.text },
  optionOnText: { color: colors.black },
  note: {
    backgroundColor: colors.surface,
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  noteCaution: { backgroundColor: colors.cautionWash },
});
