import { useEffect, useState, useSyncExternalStore } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { colors } from '@puzzle-sns/design';
import { getRandomBytes } from 'expo-crypto';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { Button, styles } from '../components/ui';
import {
  NativeProximity,
  SERVICE_UUIDS,
  type NativeProximityModule,
} from '../fit/native';
import {
  diagnosticsEnabled,
  fitTrialTimer,
  proximityDiagnostics,
} from './proximity-observer';
import { formatTrial } from './fit-trial-timer';
import type { DiagnosticSnapshot } from './proximity-observation';
import {
  formatSummary,
  RssiSurvey,
  SURVEY_DURATION_MS,
  SURVEY_WARMUP_MS,
} from './rssi-survey';

const activity: Record<DiagnosticSnapshot['activity'], string> = {
  idle: '未開始',
  starting: '開始要求済み・受信待ち',
  observing: '観測を受信',
  stopping: '停止要求中',
  stopped: '停止処理の応答あり',
  unconfirmed: '停止の応答未確認',
  unavailable: '利用不可・中断',
};
const method: Record<DiagnosticSnapshot['method'], string> = {
  none: '未観測',
  pending: '交換・測距待ち',
  ble: 'BLE',
  uwb: 'UWB距離あり',
  stale: '古い観測・方式未確認',
};
const input: Record<DiagnosticSnapshot['input'], string> = {
  native: 'native',
  simulated: '疑似近接（電波ではない）',
  unavailable: '入力なし',
};

const radioBusy: DiagnosticSnapshot['activity'][] = [
  'starting',
  'observing',
  'stopping',
];
const IDLE = { status: 'idle' } as const;
function createSurvey(): RssiSurvey | null {
  const module =
    requireOptionalNativeModule<NativeProximityModule>('Proximity');
  if (!module) return null;
  return new RssiSurvey(
    new NativeProximity(module, SERVICE_UUIDS.local),
    () => getRandomBytes(16),
    // Aggregates only, for the developer's Metro console during G-PROX calibration.
    (line) => console.log(`[RSSI測定] ${line}`),
    Platform.OS,
  );
}

/** G-PROX calibration: one 20-second RSSI survey outside FIT, with no server calls. */
function RssiSurveySection({ busy }: { busy: boolean }) {
  const [survey] = useState(createSurvey);
  const state = useSyncExternalStore(
    survey?.subscribe ?? (() => () => {}),
    survey?.snapshot ?? (() => IDLE),
    survey?.snapshot ?? (() => IDLE),
  );
  useEffect(() => () => survey?.cancel(), [survey]);
  if (!survey)
    return <Text style={styles.muted}>RSSI測定：近接モジュールなし</Text>;
  return (
    <>
      <Button
        secondary
        disabled={busy || state.status === 'running'}
        title={`RSSI測定（${(SURVEY_WARMUP_MS + SURVEY_DURATION_MS) / 1000}秒）`}
        onPress={() => void survey.start()}
      />
      {state.status === 'running' && (
        <Text style={styles.muted}>
          #{state.number} 測定中。端末を動かさないでください。
        </Text>
      )}
      {state.status === 'done' && (
        <Text style={styles.muted}>
          {formatSummary(state.number, Platform.OS, state.summary)}
        </Text>
      )}
      {state.status === 'unavailable' && (
        <Text style={styles.muted}>
          #{state.number} 中断：{state.reason}
        </Text>
      )}
    </>
  );
}

export function ProximityDiagnosticPanel() {
  const state = useSyncExternalStore(
    proximityDiagnostics.subscribe,
    proximityDiagnostics.snapshot,
    proximityDiagnostics.snapshot,
  );
  const trial = useSyncExternalStore(
    fitTrialTimer.subscribe,
    fitTrialTimer.snapshot,
    fitTrialTimer.snapshot,
  );
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => {
      proximityDiagnostics.refresh();
      fitTrialTimer.refresh();
    }, 500);
    return () => clearInterval(timer);
  }, []);
  if (!diagnosticsEnabled()) return null;
  return (
    <View
      accessibilityLabel="開発用の近接観測"
      style={{
        paddingHorizontal: 20,
        paddingVertical: 6,
        gap: 2,
        borderBottomWidth: 1,
        borderBottomColor: colors.line,
      }}
    >
      {/* Left-aligned so the Expo dev-menu button at top right cannot cover it. */}
      <View style={[styles.row, { justifyContent: 'flex-start' }]}>
        <Text style={[styles.muted, { fontSize: 13 }]}>開発用の近接観測</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={
            open ? '近接観測の詳細を閉じる' : '近接観測の詳細を開く'
          }
          hitSlop={12}
          onPress={() => setOpen(!open)}
        >
          <Text style={[styles.muted, { fontSize: 13, color: colors.text }]}>
            {open ? '閉じる' : '詳細'}
          </Text>
        </Pressable>
      </View>
      <Text style={styles.muted}>状態：{activity[state.activity]}</Text>
      {open && (
        <>
          <Text style={styles.muted}>入力：{input[state.input]}</Text>
          <Text style={styles.muted}>直近の観測：{method[state.method]}</Text>
          <Text style={styles.muted}>{formatTrial(trial)}</Text>
          <Text style={styles.muted}>
            無線停止はOSでも照合してください。距離・FITの合格判定ではありません。
          </Text>
          <RssiSurveySection busy={radioBusy.includes(state.activity)} />
        </>
      )}
    </View>
  );
}
