import { useState } from 'react';
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';
import type { BoardView } from '@puzzle-sns/contracts';
import { shareBoardImage } from '../export/board-image';
import { Button, styles } from './ui';

/** Whole-board export only; there is deliberately no single-piece export. */
export function ShareBoardButton({
  board,
  uris,
  share = shareBoardImage,
  style,
}: {
  board: BoardView;
  uris: Record<string, string>;
  share?: typeof shareBoardImage;
  style?: StyleProp<ViewStyle>;
}) {
  const [state, setState] = useState<'idle' | 'working' | 'failed'>('idle');
  // Export what is shown: wait until every visible photo has loaded.
  const ready = board.pieces.every(
    (piece) => piece.visibility !== 'visible' || Boolean(uris[piece.id]),
  );
  return (
    <View style={[{ gap: 6 }, style]}>
      <Button
        secondary
        compact
        title={
          state === 'working' ? '画像を作成しています…' : '画像で保存・共有'
        }
        disabled={!ready || state === 'working'}
        onPress={() => {
          setState('working');
          share(board, uris).then(
            () => setState('idle'),
            () => setState('failed'),
          );
        }}
      />
      {state === 'failed' && (
        <Text accessibilityRole="alert" style={styles.muted}>
          画像を保存・共有できませんでした。もう一度お試しください。
        </Text>
      )}
    </View>
  );
}
