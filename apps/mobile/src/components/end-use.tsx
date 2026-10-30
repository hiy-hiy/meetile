import { useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import type { MobileController, Snapshot } from '../controller';
import { colors } from '@puzzle-sns/design';
import { Button, styles } from './ui';

export function EndUse({
  state,
  controller,
}: {
  state: Snapshot;
  controller: MobileController;
}) {
  const [confirming, setConfirming] = useState(false);
  const sending = state.endState === 'sending';
  if (state.phase === 'ended')
    return (
      <View style={{ gap: 12 }}>
        <Text style={styles.heading}>利用を終了しました</Text>
        <Text accessibilityRole="alert" style={styles.body}>
          {state.endMessage}
        </Text>
        {state.endState === 'erasing' && (
          <ActivityIndicator color={colors.white} />
        )}
        {state.endState === 'erase-failed' && (
          <Button
            title="もう一度消去する"
            onPress={() => {
              void controller.retryErase();
            }}
          />
        )}
      </View>
    );
  return (
    <View
      style={{
        gap: 12,
        marginTop: 16,
        paddingTop: 20,
        borderTopWidth: 1,
        borderTopColor: colors.line,
      }}
    >
      <Text style={styles.heading}>利用を終了する</Text>
      {!confirming && state.endState === 'idle' ? (
        <>
          <Text style={styles.body}>
            このアプリの利用をやめ、自分の写真と本人用のデータを削除できます。
          </Text>
          <Button
            secondary
            danger
            title="利用終了について確認する"
            onPress={() => setConfirming(true)}
          />
        </>
      ) : (
        <>
          <Text style={styles.body}>
            利用を終了すると、次のことが行われます。取り消しや復元はできません。
          </Text>
          <Text style={styles.body}>
            ・これまでの全日付の自分の写真・署名・キャプションが、盤面から消えます。ピースの形と位置は無地で残り、他の参加者の盤面は続きます。
          </Text>
          <Text style={styles.body}>
            ・この端末の本人用データと画像キャッシュを消し、サインアウトします。
          </Text>
          <Text style={styles.body}>
            ・Apple・Googleのアカウントによる復元はありません。再び使うときは新しい利用者として始まります。
          </Text>
          <Text style={styles.body}>
            ・通報や利用停止などの安全のための記録は、残ることがあります。
          </Text>
          <Text style={styles.body}>
            ・未送信の通報・ブロックは、先に送信を試みます。送れなかったものは、確認のうえで破棄されます。
          </Text>
          {state.endMessage !== '' && (
            <Text accessibilityRole="alert" style={styles.body}>
              {state.endMessage}
            </Text>
          )}
          {sending && <ActivityIndicator color={colors.white} />}
          <Button
            danger
            disabled={sending}
            title={
              state.endState === 'unsent'
                ? '未送信を破棄して利用を終了する'
                : state.endState === 'failed'
                  ? 'もう一度送信する'
                  : '利用を終了する（取り消せません）'
            }
            onPress={() => {
              void controller.endUse(state.endState === 'unsent');
            }}
          />
          <Button
            secondary
            disabled={sending}
            title="キャンセル"
            onPress={() => {
              setConfirming(false);
              controller.dismissEndUse();
            }}
          />
        </>
      )}
    </View>
  );
}
