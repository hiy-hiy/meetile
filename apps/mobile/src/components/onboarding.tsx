import { useState } from 'react';
import {
  Linking,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { signatureSchema, textLength } from '@puzzle-sns/contracts';
import { colors } from '@puzzle-sns/design';
import { legalLinks } from '../native-port';
import { Button, Checkbox, Choice, Note, styles, Wordmark } from './ui';
export function Onboarding({
  accept,
}: {
  accept: (username: string) => Promise<void>;
}) {
  const [age, setAge] = useState<'under' | 'over' | null>(null);
  const [consent, setConsent] = useState(false);
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const legal = legalLinks();
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await accept(username);
    } catch {
      setError('開始できません。接続を確認してお試しください。');
    } finally {
      setBusy(false);
    }
  };
  return (
    <ScrollView
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Wordmark width={200} />
      <Text style={[styles.title, { fontSize: 32, lineHeight: 44 }]}>
        今日の一枚を、{'\n'}ひとつのピースに。
      </Text>
      <Text style={styles.body}>
        近くにいる人と、その日の写真でパズルを作ります。毎日午前4時に、新しい日が始まります。
      </Text>
      <Text style={styles.body}>
        撮影にはカメラ、対面でつなぐ操作には付近のデバイス、日次のお知らせには通知の許可を使います。必要な操作の前に説明します。位置情報は使いません。
      </Text>
      <Text style={styles.heading}>年齢を選んでください</Text>
      <Choice
        options={[
          ['under', '16歳未満'],
          ['over', '16歳以上'],
        ]}
        value={age}
        onChange={setAge}
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
        autoCorrect={false}
      />
      <Text style={styles.muted}>
        {textLength(username)} /
        20文字。空欄でも利用できます。名前は写真と一緒に、その日の作品へ残ります。
      </Text>
      <Text style={styles.body}>
        写真や文章は、つながった作品の参加者が閲覧できます。参加者が保存・共有した画像は、アプリから回収できません。
      </Text>
      {legal ? (
        <View style={{ gap: 12 }}>
          {(
            [
              ['利用規約', legal.terms],
              ['プライバシーポリシー', legal.privacy],
              ['コミュニティガイドライン', legal.community],
            ] as const
          ).map(([label, url]) => (
            <Pressable
              key={label}
              accessibilityRole="link"
              onPress={() => {
                void Linking.openURL(url).catch(() =>
                  setError('リンクを開けません。'),
                );
              }}
            >
              <Text
                style={[
                  styles.body,
                  { color: colors.text, textDecorationLine: 'underline' },
                ]}
              >
                {label}（外部サイト）
              </Text>
            </Pressable>
          ))}
        </View>
      ) : (
        <Text style={styles.body}>
          利用文書の設定が必要です。設定が完了するまで開始できません。
        </Text>
      )}
      <Checkbox
        checked={consent}
        label="利用文書を読み、同意します"
        onPress={() => setConsent(!consent)}
      />
      {error && (
        <Note caution alert>
          {error}
        </Note>
      )}
      <Button
        title={busy ? '開始しています…' : 'はじめる'}
        disabled={
          busy ||
          age !== 'over' ||
          !consent ||
          !legal ||
          !signatureSchema.safeParse(username).success
        }
        onPress={() => {
          void submit();
        }}
      />
    </ScrollView>
  );
}
