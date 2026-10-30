import { View } from 'react-native';
import type { MobileController, Snapshot } from '../controller';
import { Button, Note } from './ui';

export function BlockStatus({
  state,
  controller,
}: {
  state: Snapshot;
  controller: MobileController;
}) {
  if (state.blockState === 'idle') return null;
  return (
    <View style={{ paddingHorizontal: 20, paddingVertical: 10, gap: 8 }}>
      <Note alert>{state.blockMessage}</Note>
      {state.blockState === 'pending' && (
        <Button
          secondary
          compact
          title="ブロックを再送する"
          onPress={() => {
            void controller.retryBlocks();
          }}
        />
      )}
    </View>
  );
}
