import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { signatureSchema, textLength } from '@puzzle-sns/contracts';
import { Button, Checkbox, Choice, Note, styles } from '../components/ui';

export function LocalOnboarding({
  accept,
}: {
  accept: (username: string) => Promise<void>;
}) {
  const [age, setAge] = useState<'under' | 'over' | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function start() {
    if (age !== 'over' || !acknowledged || busy) return;
    setBusy(true);
    setError('');
    try {
      await accept(username);
    } catch {
      setError(
        '開始できません。Macとの接続を確認して、もう一度お試しください。',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ gap: 18 }}>
      <Text style={styles.heading}>内部検証を始める前に</Text>
      <Text style={styles.body}>
        開発者本人がMacと端末で行う検証です。実際の写真審査は行いません。今後の撮影では人工図形だけを使い、実在する人の写真や個人情報は使わないでください。
      </Text>
      <Text style={styles.body}>
        匿名認証と開始確認はMac内に保存します。アプリを削除した場合は復元できません。この確認は正式な利用規約への同意ではありません。
      </Text>
      <Text style={styles.heading}>年齢を選んでください</Text>
      <Choice
        options={[
          ['under', '16歳未満'],
          ['over', '16歳以上'],
        ]}
        value={age}
        onChange={setAge}
        disabled={busy}
      />
      {age === 'under' && (
        <Note caution alert>
          このアプリは16歳以上の方が対象です。
        </Note>
      )}
      <Text style={styles.heading}>署名（任意）</Text>
      <TextInput
        accessibilityLabel="署名"
        style={styles.input}
        value={username}
        onChangeText={setUsername}
        editable={!busy}
        autoCorrect={false}
      />
      <Text style={styles.muted}>
        {textLength(username)} / 20文字。空欄でも開始できます。
      </Text>
      <Checkbox
        checked={acknowledged}
        disabled={busy}
        label="内部検証の説明を確認しました"
        onPress={() => setAcknowledged(!acknowledged)}
      />
      {error && (
        <Note caution alert>
          {error}
        </Note>
      )}
      <Button
        title={busy ? '開始しています…' : '内部検証を始める'}
        disabled={
          busy ||
          age !== 'over' ||
          !acknowledged ||
          !signatureSchema.safeParse(username).success
        }
        onPress={() => {
          void start();
        }}
      />
    </View>
  );
}
