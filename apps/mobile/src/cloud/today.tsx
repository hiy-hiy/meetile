import { useRef } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { Link } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSession } from '../session';
import { Onboarding } from '../components/onboarding';
import { Capture } from '../components/capture';
import { Board } from '../components/board';
import { FitEntry } from '../components/fit';
import { Button, DayTitle, Note, styles, Wordmark } from '../components/ui';
import { colors } from '@puzzle-sns/design';
import { MAX_PIECES } from '@puzzle-sns/contracts';
import { ReportStatus } from '../components/report-status';
import { BlockStatus } from '../components/block-status';
export default function Today() {
  const { controller, state } = useSession();
  const animation = useRef<{ id: string; play: boolean } | null>(null);
  if (
    state.board &&
    state.day?.ownPieceId &&
    state.uris[state.day.ownPieceId] &&
    animation.current?.id !== state.day.ownPieceId
  ) {
    animation.current = {
      id: state.day.ownPieceId,
      play: controller.consumeCreation(),
    };
  }
  const animate = Boolean(
    animation.current?.id === state.day?.ownPieceId && animation.current?.play,
  );
  return (
    <SafeAreaView style={styles.screen}>
      <View
        style={[
          styles.row,
          {
            paddingHorizontal: 20,
            paddingVertical: 10,
          },
        ]}
      >
        <Text style={[styles.heading, { fontWeight: '900' }]}>puzzle-sns</Text>
        <Link
          href="/settings"
          accessibilityLabel="設定を開く"
          style={[styles.body, { fontWeight: '700' }]}
        >
          設定
        </Link>
      </View>
      <ReportStatus state={state} controller={controller} />
      <BlockStatus state={state} controller={controller} />
      {state.phase === 'onboarding' ? (
        <Onboarding accept={(username) => controller.accept(username)} />
      ) : state.phase === 'capture' ? (
        <Capture
          username={state.username}
          post={(base64, caption) => controller.post(base64, caption)}
        />
      ) : state.phase === 'today' ? (
        <View style={{ flex: 1, paddingBottom: 16, gap: 12 }}>
          <View style={[styles.content, { paddingVertical: 12, gap: 8 }]}>
            <Wordmark width={100} />
            {state.day && <DayTitle dayKey={state.day.dayKey} />}
            <Text style={[styles.muted, { fontSize: 13, lineHeight: 18 }]}>
              午前4時にこの形で、今日の作品になります。
            </Text>
            {state.board?.pieces.length === MAX_PIECES && (
              <Note>今日のパズルが完成しました。</Note>
            )}
            {state.day?.photoState === 'unavailable' && (
              <Note caution alert>
                {state.message}
              </Note>
            )}
          </View>
          {state.board ? (
            <Board
              fill
              board={state.board}
              uris={state.uris}
              ownPieceId={state.day?.ownPieceId ?? null}
              animate={animate}
              onAnimated={() => {
                if (animation.current) animation.current.play = false;
              }}
              onDeleteOwnPhoto={(id) => controller.deleteOwnPhoto(id)}
              onReportPhoto={(id, reason) => controller.reportPhoto(id, reason)}
              onBlockPhoto={(id) => controller.blockPhoto(id)}
              reporting={
                state.reportState === 'sending' ||
                state.blockState === 'sending'
              }
            />
          ) : (
            <ActivityIndicator color={colors.white} style={{ flex: 1 }} />
          )}
          <FitEntry state={state} controller={controller} />
        </View>
      ) : (
        <View style={styles.content}>
          {state.phase === 'loading' ? (
            <>
              <ActivityIndicator color={colors.white} />
              <Text style={styles.body}>今日の状態を確認しています。</Text>
            </>
          ) : (
            <>
              <Text accessibilityRole="alert" style={styles.body}>
                {state.phase === 'ended' ? state.endMessage : state.message}
              </Text>
              {state.capture?.status === 'processing' && (
                <ActivityIndicator color={colors.white} />
              )}
              {state.phase === 'deleting' || state.phase === 'ending' ? (
                <ActivityIndicator color={colors.white} />
              ) : state.phase === 'ended' ? null : (
                <Button
                  secondary
                  title={
                    state.capture?.status === 'rejected'
                      ? '撮り直す'
                      : state.capture?.status === 'held'
                        ? '状態を確認する'
                        : 'もう一度確認する'
                  }
                  onPress={() => {
                    void (state.capture &&
                    ['error', 'processing', 'open'].includes(
                      state.capture.status,
                    )
                      ? controller.retryCapture()
                      : controller.refresh());
                  }}
                />
              )}
              {state.phase === 'error' && (
                <Text style={styles.muted}>
                  開発用ビルドにはFirebase・App
                  Check・利用文書の設定が必要です。
                </Text>
              )}
            </>
          )}
        </View>
      )}
    </SafeAreaView>
  );
}
