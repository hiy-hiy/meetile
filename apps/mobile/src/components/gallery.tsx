import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { colors } from '@puzzle-sns/design';
import type { GalleryController } from '../gallery/controller';
import { Board, BoardThumbnail } from './board';
import { Button, DayTitle, dayParts, styles } from './ui';
import { ShareBoardButton } from './share-board';

/** Read-only UI boundary; local screenshot art never needs the canonical gallery store. */
export type GallerySource = Pick<
  GalleryController,
  'subscribe' | 'snapshot' | 'load' | 'sync'
>;

const dateLabel = (dayKey: string) => {
  const [year, month, day] = dayKey.split('-').map(Number);
  return `${year}年${month}月${day}日`;
};
const monthLabel = (dayKey: string) => {
  const [year, month] = dayKey.split('-').map(Number);
  return `${year}年${month}月`;
};
/** Entries arrive newest first; group them under their month, two to a row. */
function byMonth<T extends { view: { dayKey: string } }>(entries: T[]) {
  const groups: { key: string; label: string; rows: T[][] }[] = [];
  for (const entry of entries) {
    const key = entry.view.dayKey.slice(0, 7);
    let group = groups[groups.length - 1];
    if (group?.key !== key) {
      group = { key, label: monthLabel(entry.view.dayKey), rows: [] };
      groups.push(group);
    }
    const row = group.rows[group.rows.length - 1];
    if (row && row.length < 2) row.push(entry);
    else group.rows.push([entry]);
  }
  return groups;
}
/** Finished days, newest first. Stored on this device and readable offline. */
export function Gallery({
  gallery,
  online,
  onClose,
  closeLabel = '今日のパズルへ戻る',
}: {
  gallery: GallerySource;
  online: boolean;
  onClose: () => void;
  closeLabel?: string;
}) {
  const state = useSyncExternalStore(
    gallery.subscribe,
    gallery.snapshot,
    gallery.snapshot,
  );
  const [selected, setSelected] = useState<string | null>(null);
  const { width: windowWidth } = useWindowDimensions();
  // Two columns inside the 20 px side gutters with a 12 px gap; 12 px padding in each card.
  const card = (windowWidth - 40 - 12) / 2;
  useEffect(() => {
    void gallery.load();
    if (online) void gallery.sync();
  }, [gallery, online]);
  const entry = state.entries.find((item) => item.view.boardId === selected);
  if (entry) {
    const day = dayParts(entry.view.dayKey);
    return (
      <ScrollView contentContainerStyle={{ paddingBottom: 40, gap: 20 }}>
        <View style={{ paddingHorizontal: 20, paddingTop: 16, gap: 4 }}>
          <View style={[styles.row, { justifyContent: 'flex-start' }]}>
            <Button
              secondary
              compact
              title="一覧へ戻る"
              onPress={() => setSelected(null)}
            />
          </View>
          <DayTitle dayKey={entry.view.dayKey} />
          <Text style={styles.muted}>
            {day.year}年。午前4時に確定した作品です。
          </Text>
        </View>
        <Board
          key={entry.view.boardId}
          board={entry.view}
          uris={entry.uris}
          ownPieceId={null}
          animate={false}
          onAnimated={() => {}}
          tools={
            <ShareBoardButton
              board={entry.view}
              uris={entry.uris}
              style={{ flex: 1 }}
            />
          }
        />
      </ScrollView>
    );
  }
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.row}>
        <Text accessibilityRole="header" style={styles.title}>
          Gallery
        </Text>
        <Button secondary compact title={closeLabel} onPress={onClose} />
      </View>
      {(state.status === 'syncing' ||
        state.status === 'offline' ||
        !online) && (
        <Text style={styles.muted}>
          {state.status === 'syncing'
            ? '最新の状態を確認しています…'
            : 'オフライン：この端末に保存した作品を表示しています。'}
        </Text>
      )}
      {state.entries.length === 0 &&
        ['ready', 'offline'].includes(state.status) && (
          <Text style={styles.body}>
            最初の作品は、午前4時を過ぎるとここへ届きます。
          </Text>
        )}
      {byMonth(state.entries).map((group) => (
        <View key={group.key} style={{ gap: 12 }}>
          <Text accessibilityRole="header" style={styles.heading}>
            {group.label}
          </Text>
          {group.rows.map((row) => (
            <View
              key={row[0]?.view.boardId}
              style={{ flexDirection: 'row', gap: 12 }}
            >
              {row.map(({ view, uris }) => (
                <Pressable
                  key={view.boardId}
                  accessibilityRole="button"
                  accessibilityLabel={`${dateLabel(view.dayKey)}のパズル`}
                  onPress={() => setSelected(view.boardId)}
                  style={({ pressed }) => ({
                    width: card,
                    borderRadius: 24,
                    padding: 12,
                    gap: 8,
                    backgroundColor: pressed ? colors.raised : colors.surface,
                  })}
                >
                  <BoardThumbnail board={view} uris={uris} size={card - 24} />
                  <Text style={[styles.body, { fontWeight: '800' }]}>
                    {dayParts(view.dayKey).date}（
                    {dayParts(view.dayKey).weekday}）
                  </Text>
                </Pressable>
              ))}
            </View>
          ))}
        </View>
      ))}
      <Text style={styles.muted}>
        アプリの削除・機種変更・端末の紛失では、Galleryを復元できません。
      </Text>
    </ScrollView>
  );
}
