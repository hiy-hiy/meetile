import { View } from 'react-native';
import type { MobileController, Snapshot } from '../controller';
import { Button, Note } from './ui';

export function ReportStatus({
  state,
  controller,
}: {
  state: Snapshot;
  controller: MobileController;
}) {
  if (state.reportState === 'idle') return null;
  return (
    <View style={{ paddingHorizontal: 20, paddingVertical: 10, gap: 8 }}>
      <Note alert>{state.reportMessage}</Note>
      {state.reportState === 'pending' && (
        <Button
          secondary
          compact
          title="通報を再送する"
          onPress={() => {
            void controller.retryReports();
          }}
        />
      )}
    </View>
  );
}
