import { useState } from 'react';
import { Image, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Gallery } from '../../components/gallery';
import { Button, styles } from '../../components/ui';
import { demoGallerySource } from './data';

export function DemoGallery({
  photos,
  onClose,
}: {
  photos: readonly number[];
  onClose: () => void;
}) {
  const [source] = useState(() => {
    try {
      return demoGallerySource(
        photos.map((photo) => Image.resolveAssetSource(photo)?.uri ?? ''),
      );
    } catch {
      return null;
    }
  });
  return (
    <SafeAreaView style={styles.screen}>
      {source ? (
        <Gallery gallery={source} online onClose={onClose} closeLabel="戻る" />
      ) : (
        <View style={styles.content}>
          <Text style={styles.body}>
            撮影用画像を読み込めませんでした。Macで素材を準備してから、アプリを読み込み直してください。
          </Text>
          <Button title="戻る" onPress={onClose} />
        </View>
      )}
    </SafeAreaView>
  );
}
