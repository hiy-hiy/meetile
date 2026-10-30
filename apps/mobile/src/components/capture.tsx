import { useEffect, useRef, useState } from 'react';
import {
  Image,
  Linking,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { CameraView, useCameraPermissions, type CameraType } from 'expo-camera';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { File } from 'expo-file-system';
import { captionSchema, PHOTO, textLength } from '@puzzle-sns/contracts';
import { colors } from '@puzzle-sns/design';
import { Button, Note, styles } from './ui';
const frame = {
  width: '100%',
  aspectRatio: 1,
  borderRadius: 28,
  overflow: 'hidden',
} as const;
export function Capture({
  username,
  post,
}: {
  username: string;
  post: (base64: string, caption: string) => Promise<void>;
}) {
  const [permission, request] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  const [facing, setFacing] = useState<CameraType>('back');
  const [photo, setPhoto] = useState<{ uri: string; base64: string } | null>(
    null,
  );
  const owned = useRef(new Set<string>());
  const mounted = useRef(true);
  const [caption, setCaption] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const purge = () => {
    for (const uri of owned.current) {
      try {
        const file = new File(uri);
        if (file.exists) file.delete();
      } catch {
        /* SDK-owned temporary-file cleanup failures require physical-device verification. */
      }
    }
    owned.current.clear();
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      purge();
    };
  }, []);
  const shoot = async () => {
    setBusy(true);
    setError('');
    try {
      const raw = await camera.current?.takePictureAsync({
        quality: 1,
        exif: false,
      });
      if (!raw) throw new Error('No capture');
      owned.current.add(raw.uri);
      if (!mounted.current) {
        purge();
        return;
      }
      const size = Math.min(raw.width, raw.height);
      const context = ImageManipulator.manipulate(raw.uri)
        .crop({
          originX: Math.floor((raw.width - size) / 2),
          originY: Math.floor((raw.height - size) / 2),
          width: size,
          height: size,
        })
        .resize({ width: PHOTO.pixels, height: PHOTO.pixels });
      try {
        const rendered = await context.renderAsync();
        try {
          const result = await rendered.saveAsync({
            format: SaveFormat.JPEG,
            compress: PHOTO.quality / 100,
            base64: true,
          });
          owned.current.add(result.uri);
          if (!mounted.current) {
            purge();
            return;
          }
          if (!result.base64) throw new Error('No bytes');
          setPhoto({ uri: result.uri, base64: result.base64 });
        } finally {
          rendered.release();
        }
      } finally {
        context.release();
      }
    } catch {
      if (mounted.current)
        setError('撮影できませんでした。もう一度お試しください。');
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  if (!permission?.granted)
    return (
      <View style={styles.content}>
        <Text style={styles.heading}>今日の写真を撮影します</Text>
        <Text style={styles.body}>
          カメラの許可が必要です。位置情報やマイクは使用しません。
        </Text>
        <Button
          title="カメラを許可する"
          onPress={() => {
            void request();
          }}
        />
        {permission?.canAskAgain === false && (
          <Button
            secondary
            title="端末の設定を開く"
            onPress={() => {
              void Linking.openSettings();
            }}
          />
        )}
      </View>
    );
  const tooLong = !captionSchema.safeParse(caption).success;
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.content}
    >
      <Text accessibilityRole="header" style={styles.title}>
        今日の一枚
      </Text>
      {!photo && (
        <Text style={styles.muted}>撮った写真が、今日のピースになります。</Text>
      )}
      {photo ? (
        <Image
          accessibilityLabel="投稿する写真のプレビュー"
          source={{ uri: photo.uri }}
          style={frame}
        />
      ) : (
        <View style={frame}>
          <CameraView
            ref={camera}
            facing={facing}
            mode="picture"
            style={{ flex: 1 }}
          />
        </View>
      )}
      {!photo ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 28,
            paddingVertical: 8,
          }}
        >
          <View style={{ width: 52 }} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={busy ? '撮影しています' : '撮影する'}
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            onPress={() => {
              void shoot();
            }}
            style={{
              width: 84,
              height: 84,
              borderRadius: 42,
              borderWidth: 4,
              borderColor: colors.white,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: busy ? 0.4 : 1,
            }}
          >
            {({ pressed }) => (
              <View
                style={{
                  width: pressed ? 58 : 66,
                  height: pressed ? 58 : 66,
                  borderRadius: 33,
                  backgroundColor: colors.white,
                }}
              />
            )}
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="カメラを切り替える"
            onPress={() => setFacing(facing === 'back' ? 'front' : 'back')}
            style={({ pressed }) => ({
              width: 52,
              height: 52,
              borderRadius: 26,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: pressed ? colors.pressed : colors.raised,
            })}
          >
            <Text style={[styles.muted, { fontWeight: '800' }]}>切替</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <TextInput
            accessibilityLabel="キャプション"
            placeholder="ひとこと（なくても大丈夫）"
            placeholderTextColor={colors.muted}
            multiline
            style={[styles.input, { minHeight: 90 }]}
            value={caption}
            onChangeText={setCaption}
          />
          <View style={styles.row}>
            <Text style={styles.muted}>
              {username ? `署名：${username}` : ''}
            </Text>
            <Text style={[styles.muted, tooLong && { color: colors.danger }]}>
              {textLength(caption)} / 140文字
            </Text>
          </View>
          <Text style={styles.muted}>
            審査に通ると今日のピースになり、差し替えられません。ほかの人が保存・共有した画像は取り消せません。
          </Text>
          <Button
            title="このピースで出す"
            disabled={busy || tooLong}
            onPress={() => {
              setBusy(true);
              void post(photo.base64, caption).finally(() => setBusy(false));
            }}
          />
          <Button
            secondary
            title="撮り直す"
            disabled={busy}
            onPress={() => {
              purge();
              setPhoto(null);
            }}
          />
        </>
      )}
      {error && (
        <Note caution alert>
          {error}
        </Note>
      )}
    </ScrollView>
  );
}
