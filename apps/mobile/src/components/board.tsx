import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Image,
  ScrollView,
  Modal,
  Text,
  View,
  useWindowDimensions,
  Pressable,
  AccessibilityInfo,
} from 'react-native';
import {
  Canvas,
  Group,
  Image as SkiaImage,
  Path,
  Skia,
  useImage,
} from '@shopify/react-native-skia';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import {
  useSharedValue,
  useDerivedValue,
  withTiming,
} from 'react-native-reanimated';
import { CELL, colors, piecePath } from '@puzzle-sns/design';
import type { BoardView } from '@puzzle-sns/contracts';
import { reportReasons, type PendingReport } from '@puzzle-sns/contracts';
import { Button, Note, styles } from './ui';
import { SafeAreaView } from 'react-native-safe-area-context';
type Piece = BoardView['pieces'][number];
export function Tile({
  piece,
  uri,
}: {
  piece: Piece;
  uri: string | undefined;
}) {
  const image = useImage(uri ?? null);
  const path = useMemo(
    () => Skia.Path.MakeFromSVGString(piecePath(piece.edges)),
    [piece.edges],
  );
  if (!path) return null;
  return (
    <Group
      transform={[
        { translateX: piece.position.x * CELL },
        { translateY: piece.position.y * CELL },
      ]}
    >
      <Path
        path={path}
        color={
          piece.visibility === 'visible' && !image
            ? colors.loading
            : colors.blank
        }
      />
      {piece.visibility === 'visible' && image && (
        <Group clip={path}>
          <SkiaImage
            image={image}
            x={-18}
            y={-18}
            width={136}
            height={136}
            fit="cover"
          />
        </Group>
      )}
      {/* Cut lines: a thin gap of the ground colour between neighbouring pieces. */}
      <Path path={path} color={colors.cut} style="stroke" strokeWidth={2.5} />
    </Group>
  );
}
/** The person's own piece gets the one pastel rim on the board. */
function OwnMarker({ piece }: { piece: Piece }) {
  const path = useMemo(
    () => Skia.Path.MakeFromSVGString(piecePath(piece.edges)),
    [piece.edges],
  );
  if (!path) return null;
  return (
    <Group
      transform={[
        { translateX: piece.position.x * CELL },
        { translateY: piece.position.y * CELL },
      ]}
    >
      <Path
        path={path}
        color={colors.accent}
        style="stroke"
        strokeWidth={6}
        strokeJoin="round"
      />
    </Group>
  );
}
/** Board units covered by the puzzle, including the photo overhang around each cell. */
function extent(pieces: Piece[]) {
  const xs = pieces.map((p) => p.position.x);
  const ys = pieces.map((p) => p.position.y);
  const minX = Math.min(...xs) * CELL - 18;
  const minY = Math.min(...ys) * CELL - 18;
  const maxX = Math.max(...xs) * CELL + 118;
  const maxY = Math.max(...ys) * CELL + 118;
  return { minX, minY, width: maxX - minX, height: maxY - minY };
}
/**
 * A still picture of a whole board with its photos. Nothing here can be touched: it is for
 * browsing (Gallery) and for showing the result (FIT), so it never looks like something to move.
 * `reveal` plays one short grow-and-fade, skipped when the person prefers reduced motion.
 */
export function BoardThumbnail({
  board,
  uris,
  size,
  reveal = false,
  ownPieceId = null,
}: {
  board: BoardView;
  uris: Record<string, string>;
  size: number;
  reveal?: boolean;
  ownPieceId?: string | null;
}) {
  const box = useMemo(() => extent(board.pieces), [board.pieces]);
  const pad = size * 0.06;
  const scale = (size - pad * 2) / Math.max(box.width, box.height);
  const offsetX = (size - box.width * scale) / 2;
  const offsetY = (size - box.height * scale) / 2;
  const own = board.pieces.find((piece) => piece.id === ownPieceId);
  const progress = useSharedValue(reveal ? 0 : 1);
  useEffect(() => {
    if (!reveal) return;
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduced) => {
      if (!mounted) return;
      progress.value = reduced ? 1 : withTiming(1, { duration: 700 });
    });
    return () => {
      mounted = false;
    };
  }, [reveal, progress]);
  const transform = useDerivedValue(() => {
    const grow = 0.88 + 0.12 * progress.value;
    return [
      { translateX: size / 2 },
      { translateY: size / 2 },
      { scale: grow },
      { translateX: -size / 2 + offsetX },
      { translateY: -size / 2 + offsetY },
      { scale },
      { translateX: -box.minX },
      { translateY: -box.minY },
    ];
  });
  return (
    <Canvas
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size }}
    >
      <Group transform={transform} opacity={progress}>
        {board.pieces.map((piece) => (
          <Tile key={piece.id} piece={piece} uri={uris[piece.id]} />
        ))}
        {own && <OwnMarker piece={own} />}
      </Group>
    </Canvas>
  );
}

export function Board({
  board,
  uris,
  ownPieceId,
  animate,
  onAnimated,
  notice,
  tools,
  onDeleteOwnPhoto,
  onReportPhoto,
  onBlockPhoto,
  reporting = false,
  fill = false,
}: {
  board: BoardView;
  uris: Record<string, string>;
  ownPieceId: string | null;
  animate: boolean;
  onAnimated: () => void;
  notice?: string;
  /** Extra actions shown beside the own-photo button, e.g. export. */
  tools?: ReactNode;
  onDeleteOwnPhoto?: (pieceId: string) => Promise<void>;
  onReportPhoto?: (
    pieceId: string,
    reason: PendingReport['reason'],
  ) => Promise<void>;
  onBlockPhoto?: (pieceId: string) => Promise<void>;
  reporting?: boolean;
  /** Take whatever height the parent leaves, so a screen can fit without scrolling. */
  fill?: boolean;
}) {
  const { width: windowWidth } = useWindowDimensions();
  // The board is a rounded card inset 16 from each edge.
  const width = windowWidth - 32;
  // The board is the screen's main subject: taller than wide on phones.
  const [measured, setMeasured] = useState(0);
  const height = fill
    ? measured
    : Math.max(320, Math.min(560, Math.round(width * 1.2)));
  const [selected, setSelected] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmReport, setConfirmReport] = useState(false);
  const [confirmBlock, setConfirmBlock] = useState(false);
  const [reason, setReason] = useState<PendingReport['reason'] | null>(null);
  const [menu, setMenu] = useState(false);
  const [hinted, setHinted] = useState(false);
  const select = (id: string | null) => {
    setMenu(false);
    setConfirmDelete(false);
    setConfirmReport(false);
    setConfirmBlock(false);
    setReason(null);
    setSelected(id);
  };
  const detail = board.pieces.find(
    (piece) =>
      piece.id === selected && piece.visibility === 'visible' && uris[piece.id],
  );
  const bounds = useMemo(
    () => ({
      minX: Math.min(...board.pieces.map((p) => p.position.x)) * CELL - 18,
      minY: Math.min(...board.pieces.map((p) => p.position.y)) * CELL - 18,
      maxX: Math.max(...board.pieces.map((p) => p.position.x)) * CELL + 118,
      maxY: Math.max(...board.pieces.map((p) => p.position.y)) * CELL + 118,
    }),
    [board.pieces],
  );
  const initial = Math.max(
    0.05,
    Math.min(
      (width - 48) / (bounds.maxX - bounds.minX),
      (height - 48) / (bounds.maxY - bounds.minY),
    ),
  );
  const scale = useSharedValue(initial);
  const startScale = useSharedValue(initial);
  const panX = useSharedValue(0);
  const panY = useSharedValue(0);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const opacity = useSharedValue(1);
  useEffect(() => {
    scale.value = initial;
    startScale.value = initial;
    panX.value = 0;
    panY.value = 0;
  }, [initial, scale, startScale, panX, panY]);
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduced) => {
      if (!mounted) return;
      opacity.value = animate && !reduced ? 0 : 1;
      if (animate && !reduced) opacity.value = withTiming(1, { duration: 400 });
      if (animate) onAnimated();
    });
    return () => {
      mounted = false;
    };
  }, [animate, opacity]);
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  const own = board.pieces.find((piece) => piece.id === ownPieceId);
  const transform = useDerivedValue(() => [
    { translateX: width / 2 + panX.value },
    { translateY: height / 2 + panY.value },
    { scale: scale.value },
    { translateX: -centerX },
    { translateY: -centerY },
  ]);
  const pan = Gesture.Pan()
    .onStart(() => {
      startX.value = panX.value;
      startY.value = panY.value;
    })
    .onUpdate((event) => {
      panX.value = Math.max(
        -width * 3,
        Math.min(width * 3, startX.value + event.translationX),
      );
      panY.value = Math.max(
        -height * 3,
        Math.min(height * 3, startY.value + event.translationY),
      );
    });
  const pinch = Gesture.Pinch()
    .onStart(() => {
      startScale.value = scale.value;
    })
    .onUpdate((event) => {
      scale.value = Math.min(
        initial * 6,
        Math.max(initial * 0.7, startScale.value * event.scale),
      );
    });
  const tap = Gesture.Tap()
    .maxDistance(8)
    .runOnJS(true)
    .onEnd((event, success) => {
      if (!success) return;
      setHinted(true);
      const x = (event.x - width / 2 - panX.value) / scale.value + centerX;
      const y = (event.y - height / 2 - panY.value) / scale.value + centerY;
      const piece = [...board.pieces]
        .reverse()
        .find(
          (p) =>
            p.visibility === 'visible' &&
            uris[p.id] &&
            Skia.Path.MakeFromSVGString(piecePath(p.edges))?.contains(
              x - p.position.x * CELL,
              y - p.position.y * CELL,
            ),
        );
      if (piece) select(piece.id);
    });
  return (
    <View style={[{ gap: 12 }, fill && { flex: 1 }]}>
      <View
        testID="board-card"
        onLayout={
          fill
            ? (event) =>
                setMeasured(Math.round(event.nativeEvent.layout.height))
            : undefined
        }
        style={{
          ...(fill && { flex: 1 }),
          marginHorizontal: 16,
          borderRadius: 28,
          backgroundColor: colors.surface,
          overflow: 'hidden',
        }}
      >
        {height > 0 && (
          <GestureDetector
            gesture={Gesture.Race(tap, Gesture.Simultaneous(pan, pinch))}
          >
            <Canvas
              accessibilityLabel="今日のパズル。指で移動、二本指で拡大、写真をタップして詳細を表示"
              style={{ width, height }}
            >
              <Group transform={transform} opacity={opacity}>
                {board.pieces.map((piece) => (
                  <Tile key={piece.id} piece={piece} uri={uris[piece.id]} />
                ))}
                {own && <OwnMarker piece={own} />}
              </Group>
            </Canvas>
          </GestureDetector>
        )}
        {!hinted && (
          <View
            pointerEvents="none"
            style={{ position: 'absolute', bottom: 14, left: 0, right: 0 }}
          >
            <View
              style={[styles.chip, { alignSelf: 'center', paddingVertical: 6 }]}
            >
              <Text style={[styles.muted, { fontSize: 13 }]}>
                写真に触れると大きく見られます
              </Text>
            </View>
          </View>
        )}
      </View>
      <View style={{ paddingHorizontal: 16, flexDirection: 'row', gap: 10 }}>
        {ownPieceId !== null && (
          <Button
            secondary
            compact
            title="自分のピース"
            disabled={!uris[ownPieceId]}
            onPress={() => {
              setHinted(true);
              select(ownPieceId);
            }}
            style={{ flex: 1 }}
          />
        )}
        {tools}
      </View>
      <Modal
        visible={Boolean(detail)}
        transparent
        animationType="fade"
        onRequestClose={() => select(null)}
      >
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.75)' }}>
          <Pressable
            accessible={false}
            onPress={() => select(null)}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
            }}
          />
          <SafeAreaView
            pointerEvents="box-none"
            style={{
              flex: 1,
              padding: 16,
              justifyContent: 'center',
              alignItems: 'center',
            }}
          >
            <View
              style={{
                height: '100%',
                maxHeight: 760,
                width: '100%',
                maxWidth: 560,
                backgroundColor: colors.surface,
                borderRadius: 28,
                overflow: 'hidden',
              }}
            >
              <View style={{ padding: 16, gap: 8, flexShrink: 0 }}>
                {notice && <Note caution>{notice}</Note>}
                <View style={styles.row}>
                  <Text
                    accessibilityRole="header"
                    style={[styles.heading, { flex: 1 }]}
                  >
                    {confirmReport
                      ? '通報理由'
                      : confirmBlock
                        ? '安全上のブロック'
                        : confirmDelete
                          ? '写真の削除'
                          : ''}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="閉じる"
                    hitSlop={8}
                    onPress={() => select(null)}
                    style={({ pressed }) => ({
                      width: 40,
                      height: 40,
                      borderRadius: 20,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: pressed ? colors.pressed : colors.raised,
                    })}
                  >
                    <Text style={[styles.body, { fontWeight: '800' }]}>✕</Text>
                  </Pressable>
                </View>
              </View>
              <ScrollView
                key={
                  confirmReport
                    ? 'report'
                    : confirmBlock
                      ? 'block'
                      : confirmDelete
                        ? 'delete'
                        : 'detail'
                }
                testID="piece-detail-scroll"
                style={{ flex: 1, minHeight: 0 }}
                contentContainerStyle={{ padding: 16, gap: 14 }}
              >
                {confirmReport ? (
                  <>
                    {Object.entries(reportReasons).map(([value, label]) => (
                      <Pressable
                        key={value}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: reason === value }}
                        accessibilityLabel={label}
                        onPress={() =>
                          setReason(value as PendingReport['reason'])
                        }
                        style={[
                          styles.input,
                          reason === value && { backgroundColor: colors.white },
                        ]}
                      >
                        <Text
                          style={[
                            styles.body,
                            reason === value && {
                              color: colors.black,
                              fontWeight: '700',
                            },
                          ]}
                        >
                          {label}
                        </Text>
                      </Pressable>
                    ))}
                    <Text style={styles.body}>
                      通報すると、この写真・署名・キャプションを自分の画面で非表示にします。通報理由を運営へ送信します。
                    </Text>
                  </>
                ) : confirmBlock ? (
                  <Text accessibilityRole="alert" style={styles.body}>
                    この相手とは、今後も互いの写真・署名・キャプションを非表示にします。ピースの形と配置は残り、同じパズルへ入ることはあります。相手にブロックの通知は送りません。
                  </Text>
                ) : confirmDelete ? (
                  <Text accessibilityRole="alert" style={styles.body}>
                    この写真と、その日の署名・キャプションを削除します。ピースの形と配置は残り、今日は撮り直しやFITができなくなります。保存・共有された画像は回収できません。
                  </Text>
                ) : (
                  <>
                    {detail && uris[detail.id] && (
                      <Image
                        accessibilityLabel="ピースの写真"
                        source={{ uri: uris[detail.id] }}
                        style={{
                          width: '100%',
                          aspectRatio: 1,
                          borderRadius: 20,
                        }}
                      />
                    )}
                    {detail?.username ? (
                      <Text style={styles.heading}>{detail.username}</Text>
                    ) : null}
                    {detail?.caption ? (
                      <Text style={styles.body}>{detail.caption}</Text>
                    ) : null}
                  </>
                )}
              </ScrollView>
              {(confirmReport || confirmBlock || confirmDelete
                ? true
                : detail &&
                  (detail.id === ownPieceId
                    ? Boolean(onDeleteOwnPhoto)
                    : Boolean(onReportPhoto || onBlockPhoto))) && (
                <View
                  testID="piece-detail-actions"
                  style={{
                    padding: 16,
                    gap: 10,
                    flexShrink: 0,
                    borderTopWidth: 1,
                    borderTopColor: colors.line,
                  }}
                >
                  {confirmReport && detail && onReportPhoto ? (
                    <>
                      <Button
                        title="通報して非表示にする"
                        disabled={!reason || reporting}
                        onPress={() => {
                          if (!reason) return;
                          const id = detail.id;
                          const selectedReason = reason;
                          select(null);
                          void onReportPhoto(id, selectedReason);
                        }}
                      />
                      <Button
                        secondary
                        title="キャンセル"
                        onPress={() => {
                          setConfirmReport(false);
                          setReason(null);
                        }}
                      />
                    </>
                  ) : confirmBlock && detail && onBlockPhoto ? (
                    <>
                      <Button
                        title="ブロックする"
                        disabled={reporting}
                        onPress={() => {
                          const id = detail.id;
                          select(null);
                          void onBlockPhoto(id);
                        }}
                      />
                      <Button
                        secondary
                        title="キャンセル"
                        onPress={() => setConfirmBlock(false)}
                      />
                    </>
                  ) : confirmDelete && detail && onDeleteOwnPhoto ? (
                    <>
                      <Button
                        danger
                        title="削除する"
                        disabled={reporting}
                        onPress={() => {
                          const id = detail.id;
                          select(null);
                          void onDeleteOwnPhoto(id);
                        }}
                      />
                      <Button
                        secondary
                        title="キャンセル"
                        onPress={() => setConfirmDelete(false)}
                      />
                    </>
                  ) : (
                    <>
                      {detail &&
                        detail.id === ownPieceId &&
                        onDeleteOwnPhoto && (
                          <Button
                            secondary
                            danger
                            compact
                            title="写真を削除"
                            disabled={reporting}
                            onPress={() => setConfirmDelete(true)}
                          />
                        )}
                      {detail &&
                        detail.id !== ownPieceId &&
                        (onReportPhoto || onBlockPhoto) &&
                        (menu ? (
                          <>
                            {onReportPhoto && (
                              <Button
                                secondary
                                title="この写真を通報する"
                                disabled={reporting}
                                onPress={() => setConfirmReport(true)}
                              />
                            )}
                            {onBlockPhoto && (
                              <Button
                                secondary
                                title="この相手を安全上ブロックする"
                                disabled={reporting}
                                onPress={() => setConfirmBlock(true)}
                              />
                            )}
                          </>
                        ) : (
                          <Button
                            secondary
                            compact
                            title="通報・ブロック"
                            onPress={() => setMenu(true)}
                          />
                        ))}
                    </>
                  )}
                </View>
              )}
            </View>
          </SafeAreaView>
        </View>
      </Modal>
    </View>
  );
}
