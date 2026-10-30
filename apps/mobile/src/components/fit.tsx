import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  AccessibilityInfo,
  Animated,
  AppState,
  Easing,
  Image,
  Modal,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors } from '@puzzle-sns/design';
import { MAX_PIECES, type BoardView } from '@puzzle-sns/contracts';
import type { MobileController, Snapshot } from '../controller';
import type { FitController } from '../fit/controller';
import { proximitySource } from '../fit/factory';
import type { FitStage } from '../fit/machine';
import { BoardThumbnail } from './board';
import { Button, Note, styles } from './ui';

/** What happened and, where it helps, what to do next. */
const messages: Record<FitStage, { title: string; hint?: string }> = {
  idle: { title: '' },
  searching: {
    title: '相手の端末を探しています',
    hint: '二人ともこの画面のまま、端末を並べて10cmくらいまで近づけてください。',
  },
  multiple: {
    title: '近くにほかの端末があります',
    hint: '少し離れて、二人だけの状態でもう一度お試しください。',
  },
  conflict: {
    title: '近くにほかの端末があったかもしれません',
    hint: '少し離れて、もう一度お試しください。',
  },
  matched: {
    title: '相手を確かめています',
    hint: 'そのままの位置で、少しだけ待ってください。',
  },
  preview: { title: 'この人が目の前にいる相手ですか？' },
  waiting: {
    title: '相手の確認を待っています',
    hint: '相手が「この人とFITする」を押すと、つながります。',
  },
  merged: { title: '二人のパズルがひとつになりました' },
  'not-merged': {
    title: '今回は形が合いませんでした',
    hint: '形が合わない日も、パズルの一部です。どちらかのパズルが別のFITで育つと、また試せます。',
  },
  'board-changed': {
    title: '直前にパズルが育ち、今回は合いませんでした',
    hint: '新しい形で、もう一度試せます。',
  },
  'already-connected': {
    title: 'もう同じパズルに入っています',
    hint: 'FITしなくても、同じ盤面を見られます。',
  },
  'partner-left': { title: '相手が画面を離れました' },
  timeout: {
    title: '時間切れになりました',
    hint: 'もう一度お試しください。',
  },
  'day-changed': {
    title: '日付が切り替わりました',
    hint: '新しい日にもう一度お試しください。',
  },
  unavailable: { title: 'この端末では近くの端末を探せません' },
  'rate-limited': {
    title: '短時間に試しすぎました',
    hint: 'しばらく待ってからお試しください。',
  },
  'not-ready': {
    title: '準備ができていません',
    hint: '通信状態を確認してください。',
  },
};
const unavailableHelp: Record<string, string> = {
  permission:
    '設定で「付近のデバイス」またはBluetoothの許可をオンにしてください。',
  'bluetooth-off': 'Bluetoothをオンにしてください。',
  unsupported: 'この端末またはビルドは近接通信に対応していません。',
  interrupted:
    '近接通信が中断されました。アプリを開いた状態で、もう一度お試しください。',
};
const terminal = (stage: FitStage) =>
  !['searching', 'multiple', 'matched', 'preview', 'waiting'].includes(stage);
const SLOW_SEARCH_MS = 15_000;
const stepLabels = ['近づける', '相手を確かめる', '二人で決める'];
/** The step each active stage belongs to; the order is real, so the steps are numbered. */
const stepOf: Partial<Record<FitStage, number>> = {
  searching: 0,
  multiple: 0,
  matched: 1,
  preview: 1,
  waiting: 2,
};

function Steps({ index }: { index: number }) {
  return (
    <View
      accessible
      accessibilityLabel={`手順 ${index + 1} / ${stepLabels.length}：${stepLabels[index]}`}
      style={{ flexDirection: 'row', gap: 14 }}
    >
      {stepLabels.map((label, i) => (
        <View
          key={label}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
        >
          <View
            style={{
              width: 22,
              height: 22,
              borderRadius: 11,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: i <= index ? colors.accent : colors.raised,
            }}
          >
            <Text
              style={{
                fontSize: 12,
                fontWeight: '800',
                color: i <= index ? colors.black : colors.muted,
              }}
            >
              {i + 1}
            </Text>
          </View>
          <Text
            style={[
              styles.muted,
              { fontSize: 13 },
              i === index && { color: colors.text, fontWeight: '800' },
            ]}
          >
            {label}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** Two rings spreading from a core: the screen is alive and looking, not stuck. */
function Ripple({ active }: { active: boolean }) {
  const rings = useRef([new Animated.Value(0), new Animated.Value(0)]).current;
  useEffect(() => {
    if (!active) return;
    let mounted = true;
    let loops: Animated.CompositeAnimation[] = [];
    void AccessibilityInfo.isReduceMotionEnabled().then((reduced) => {
      if (!mounted || reduced) return;
      loops = rings.map((ring, i) =>
        Animated.sequence([
          Animated.delay(i * 900),
          Animated.loop(
            Animated.timing(ring, {
              toValue: 1,
              duration: 1800,
              easing: Easing.out(Easing.quad),
              useNativeDriver: true,
            }),
          ),
        ]),
      );
      for (const loop of loops) loop.start();
    });
    return () => {
      mounted = false;
      for (const loop of loops) loop.stop();
    };
  }, [active, rings]);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: 160,
        height: 160,
        alignSelf: 'center',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {rings.map((ring, i) => (
        <Animated.View
          key={i}
          style={{
            position: 'absolute',
            width: 120,
            height: 120,
            borderRadius: 60,
            borderWidth: 2,
            borderColor: colors.glow,
            opacity: ring.interpolate({
              inputRange: [0, 1],
              outputRange: [0.7, 0],
            }),
            transform: [
              {
                scale: ring.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0.4, 1.3],
                }),
              },
            ],
          }}
        />
      ))}
      <View
        style={{
          width: 30,
          height: 30,
          borderRadius: 15,
          backgroundColor: colors.accent,
        }}
      />
    </View>
  );
}

export function FitPanel({
  fit,
  onClose,
  board = null,
  uris = {},
  ownPieceId = null,
}: {
  fit: FitController;
  onClose: () => void;
  /** The latest shared board, shown when two puzzles have just become one. */
  board?: BoardView | null;
  uris?: Record<string, string>;
  ownPieceId?: string | null;
}) {
  const state = useSyncExternalStore(fit.subscribe, fit.snapshot, fit.snapshot);
  const { width } = useWindowDimensions();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (state.stage !== 'searching') return;
    const timer = setTimeout(() => setSlow(true), SLOW_SEARCH_MS);
    return () => clearTimeout(timer);
  }, [state.stage]);
  useEffect(() => {
    void fit.start();
    // Leaving the foreground ends an unconfirmed attempt (spec §9.1: app must be in front).
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void fit.recheckDay();
      else void fit.leave();
    });
    return () => {
      subscription.remove();
      void fit.leave();
    };
  }, [fit]);
  const close = () => {
    void fit.leave();
    onClose();
  };
  const busy = ['searching', 'multiple', 'matched', 'waiting'].includes(
    state.stage,
  );
  const message = messages[state.stage];
  const step = stepOf[state.stage];
  return (
    <View accessibilityLabel="FIT" style={{ flex: 1 }}>
      <ScrollView
        contentContainerStyle={[styles.content, { flexGrow: 1, gap: 20 }]}
      >
        <Text accessibilityRole="header" style={styles.title}>
          FIT
        </Text>
        {step !== undefined && <Steps index={step} />}
        {busy && <Ripple active />}
        <View style={{ gap: 8 }}>
          <Text
            accessibilityRole="alert"
            style={[styles.heading, { fontSize: 22, lineHeight: 32 }]}
          >
            {message.title}
          </Text>
          {message.hint ? (
            <Text style={styles.body}>{message.hint}</Text>
          ) : null}
          {state.stage === 'unavailable' && state.reason && (
            <Text style={styles.body}>{unavailableHelp[state.reason]}</Text>
          )}
          {slow && state.stage === 'searching' && (
            <View style={{ gap: 2, paddingTop: 8 }}>
              <Text style={[styles.muted, { fontWeight: '800' }]}>
                見つからないときは
              </Text>
              <Text style={styles.muted}>・相手もFIT画面を開いていますか</Text>
              <Text style={styles.muted}>・Bluetoothはオンですか</Text>
              <Text style={styles.muted}>・近くにほかの端末はありませんか</Text>
            </View>
          )}
        </View>
        {state.stage === 'merged' && board && (
          <View style={{ alignItems: 'center' }}>
            <BoardThumbnail
              reveal
              board={board}
              uris={uris}
              ownPieceId={ownPieceId}
              size={Math.min(width - 40, 380)}
            />
          </View>
        )}
        {state.preview &&
          (state.stage === 'preview' || state.stage === 'waiting') && (
            <View style={{ gap: 8, alignItems: 'flex-start' }}>
              {state.preview.visibility === 'visible' &&
              state.preview.imageBase64 ? (
                <Image
                  accessibilityLabel="相手のピース"
                  source={{
                    uri: `data:image/jpeg;base64,${state.preview.imageBase64}`,
                  }}
                  style={{
                    width: 260,
                    height: 260,
                    borderRadius: 28,
                    borderWidth: 4,
                    borderColor: colors.white,
                  }}
                />
              ) : (
                <Note>相手のピースは表示できません。</Note>
              )}
              {state.preview.username ? (
                <Text style={styles.heading}>{state.preview.username}</Text>
              ) : null}
              {state.preview.caption ? (
                <Text style={styles.body}>{state.preview.caption}</Text>
              ) : null}
            </View>
          )}
      </ScrollView>
      <View
        style={{
          paddingHorizontal: 20,
          paddingVertical: 16,
          gap: 10,
        }}
      >
        {state.stage === 'preview' && (
          <>
            <Button
              title="この人とFITする"
              onPress={() => void fit.confirm()}
            />
            <Button secondary title="違う人です" onPress={close} />
          </>
        )}
        {state.stage === 'waiting' && (
          <Button secondary title="やめる" onPress={close} />
        )}
        {(state.stage === 'searching' ||
          state.stage === 'multiple' ||
          state.stage === 'matched') && (
          <Button secondary title="やめる" onPress={close} />
        )}
        {terminal(state.stage) && (
          <>
            {[
              'timeout',
              'partner-left',
              'not-ready',
              'day-changed',
              'board-changed',
              'conflict',
              'unavailable',
              'idle',
            ].includes(state.stage) && (
              <Button title="もう一度試す" onPress={() => void fit.start()} />
            )}
            {state.stage === 'merged' ? (
              <Button title="盤面を見る" onPress={close} />
            ) : (
              <Button secondary title="閉じる" onPress={close} />
            )}
          </>
        )}
      </View>
    </View>
  );
}

/** The FIT entry for Today: closed by default; only offered with a ready, unfinished board. */
export function FitEntry({
  state,
  controller,
}: {
  state: Snapshot;
  controller: MobileController;
}) {
  const [open, setOpen] = useState(false);
  const fit = useMemo(
    () => (open ? controller.createFit(proximitySource(controller)) : null),
    [open, controller],
  );
  const available =
    state.phase === 'today' &&
    state.day?.photoState === 'ready' &&
    (state.board?.pieces.length ?? 0) < MAX_PIECES;
  if (!available) return null;
  return (
    <View style={{ paddingHorizontal: 16, gap: 8 }}>
      <Button title="FITする" onPress={() => setOpen(true)} />
      {fit && (
        <Modal
          visible
          animationType="slide"
          onRequestClose={() => {
            void fit.leave();
            setOpen(false);
          }}
        >
          <SafeAreaView
            style={[styles.screen, { backgroundColor: colors.fitWash }]}
          >
            <FitPanel
              fit={fit}
              onClose={() => setOpen(false)}
              board={state.board}
              uris={state.uris}
              ownPieceId={state.day?.ownPieceId ?? null}
            />
          </SafeAreaView>
        </Modal>
      )}
    </View>
  );
}
