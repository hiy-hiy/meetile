import { useState } from 'react';
import { Linking, ScrollView, Text, TextInput } from 'react-native';
import { Link } from 'expo-router';
import Constants from 'expo-constants';
import { useCameraPermissions } from 'expo-camera';
import { SafeAreaView } from 'react-native-safe-area-context';
import { signatureSchema, textLength } from '@puzzle-sns/contracts';
import { useSession } from '../session';
import { legalLinks } from '../native-port';
import { colors } from '@puzzle-sns/design';
import { Button, Note, styles } from '../components/ui';
import { EndUse } from '../components/end-use';
export default function Settings() {
  const { controller, state } = useSession();
  const [username, setUsername] = useState(state.username);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [permission] = useCameraPermissions();
  const legal = legalLinks();
  const save = async () => {
    setBusy(true);
    try {
      await controller.setUsername(username);
      setMessage('次回の写真から、この署名を使います。');
    } catch {
      setMessage('保存できませんでした。');
    } finally {
      setBusy(false);
    }
  };
  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <Link
          href="/"
          style={[styles.body, { color: colors.text, fontWeight: '700' }]}
        >
          戻る
        </Link>
        <Text style={styles.title}>設定</Text>
        {state.phase === 'ended' ? (
          <EndUse state={state} controller={controller} />
        ) : (
          <>
            <Text style={styles.heading}>次回以降の署名</Text>
            <TextInput
              style={styles.input}
              accessibilityLabel="次回以降の署名"
              value={username}
              onChangeText={setUsername}
              autoCorrect={false}
            />
            <Text style={styles.muted}>
              {textLength(username)} /
              20文字。確定した写真の署名は変わりません。
            </Text>
            <Button
              title="署名を保存する"
              disabled={busy || !signatureSchema.safeParse(username).success}
              onPress={() => {
                void save();
              }}
            />
            {message && <Note alert>{message}</Note>}
            <Text style={styles.heading}>カメラ権限</Text>
            <Text style={styles.body}>
              {permission?.granted ? '許可済み' : '未許可'}
            </Text>
            <Button
              secondary
              title="端末の設定を開く"
              onPress={() => {
                void Linking.openSettings();
              }}
            />
            {legal &&
              (
                [
                  ['利用規約', legal.terms],
                  ['プライバシーポリシー', legal.privacy],
                  ['コミュニティガイドライン', legal.community],
                ] as const
              ).map(([label, url]) => (
                <Button
                  key={label}
                  secondary
                  title={label}
                  onPress={() => {
                    void Linking.openURL(url).catch(() =>
                      setMessage('リンクを開けません。'),
                    );
                  }}
                />
              ))}
            <Note caution>
              アンインストールすると、作品の端末保存や本人用の情報は復元できません。Apple・Googleのアカウントによる復元はありません。
            </Note>
            <Text style={styles.muted}>
              バージョン {Constants.expoConfig?.version ?? '0.0.0'}
            </Text>
            <EndUse state={state} controller={controller} />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
