import { useRef } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { colors } from '@puzzle-sns/design';
import { MAX_PIECES } from '@puzzle-sns/contracts';
import type { MobileController, Snapshot } from '../controller';
import { Board } from '../components/board';
import { FitEntry } from '../components/fit';
import { Button, DayTitle, Note, styles, Wordmark } from '../components/ui';
import { ShareBoardButton } from '../components/share-board';
import { NotificationSetting } from '../components/notification-setting';

export function LocalToday({
  state,
  controller,
  onGallery,
  onDemoGallery,
  onNotificationsGranted,
}: {
  state: Snapshot;
  controller: MobileController;
  onGallery: () => void;
  onDemoGallery?: () => void;
  onNotificationsGranted: () => void;
}) {
  const animation = useRef<{ id: string; play: boolean } | null>(null);
  const ownPieceId = state.day?.ownPieceId ?? null;
  if (
    state.board &&
    ownPieceId &&
    state.uris[ownPieceId] &&
    animation.current?.id !== ownPieceId
  ) {
    animation.current = { id: ownPieceId, play: controller.consumeCreation() };
  }
  return (
    // A fixed screen that never scrolls: the board shrinks to whatever the header and FIT leave.
    // Extra bottom room: gesture-navigation phones report almost no inset for the home bar.
    <View style={{ flex: 1, paddingBottom: 28, gap: 12 }}>
      <View style={[styles.row, { paddingHorizontal: 20, paddingTop: 12 }]}>
        <View style={{ flex: 1, gap: 2 }}>
          <Wordmark width={100} />
          {state.day && <DayTitle dayKey={state.day.dayKey} />}
          <Text style={[styles.muted, { fontSize: 13, lineHeight: 18 }]}>
            午前4時にこの形で、今日の作品になります。
          </Text>
        </View>
        <View style={{ gap: 8 }}>
          <Button secondary compact title="Gallery" onPress={onGallery} />
          {onDemoGallery && (
            <Button
              secondary
              compact
              title="撮影用ギャラリー"
              onPress={onDemoGallery}
            />
          )}
        </View>
      </View>
      {state.day?.photoState === 'unavailable' && (
        <View style={{ paddingHorizontal: 20 }}>
          <Note caution alert>
            {state.message}
          </Note>
        </View>
      )}
      {state.board?.pieces.length === MAX_PIECES && (
        <View style={{ paddingHorizontal: 20 }}>
          <Note>今日のパズルが完成しました。</Note>
        </View>
      )}
      {state.board ? (
        <Board
          fill
          key={state.board.boardId}
          board={state.board}
          uris={state.uris}
          ownPieceId={ownPieceId}
          animate={Boolean(
            animation.current?.id === ownPieceId && animation.current?.play,
          )}
          onAnimated={() => {
            if (animation.current) animation.current.play = false;
          }}
          notice="ローカル検証・実審査なし"
          tools={
            <ShareBoardButton
              board={state.board}
              uris={state.uris}
              style={{ flex: 1 }}
            />
          }
          onDeleteOwnPhoto={(id) => controller.deleteOwnPhoto(id)}
          onReportPhoto={(id, reason) => controller.reportPhoto(id, reason)}
          onBlockPhoto={(id) => controller.blockPhoto(id)}
          reporting={
            state.reportState === 'sending' || state.blockState === 'sending'
          }
        />
      ) : (
        <ActivityIndicator
          color={colors.white}
          accessibilityLabel="パズルを取得しています"
          style={{ flex: 1 }}
        />
      )}
      <FitEntry state={state} controller={controller} />
      <View style={{ paddingHorizontal: 20 }}>
        <NotificationSetting onGranted={onNotificationsGranted} />
      </View>
    </View>
  );
}
