import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, ScrollView, Text, View } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MobileController } from '../controller';
import { colors } from '@puzzle-sns/design';
import { Button, Note, styles, Wordmark } from '../components/ui';
import { LOCAL_TEST_VERSION } from '../../../../tools/local-development/config';
import { LOCAL_GALLERY, localPort } from './native-port';
import { sqliteGalleryStore } from '../gallery/store';
import { Gallery } from '../components/gallery';
import { planReminders } from '../notifications/plan';
import { applyReminders } from '../notifications/scheduler';
import { LocalOnboarding } from './onboarding';
import { Capture } from '../components/capture';
import { ProximityDiagnosticPanel } from './proximity-diagnostics';
import { LocalToday } from './today';
import { ReportStatus } from '../components/report-status';
import { BlockStatus } from '../components/block-status';
import { demoPhotos } from '@puzzle-sns/gallery-demo-assets';
import { DemoGallery } from './gallery-demo/screen';

export default function Connection() {
  const [demoOpen, setDemoOpen] = useState(false);
  if (demoOpen)
    return (
      <DemoGallery photos={demoPhotos} onClose={() => setDemoOpen(false)} />
    );
  return (
    <LocalConnection
      {...(demoPhotos.length === 12
        ? { onDemoGallery: () => setDemoOpen(true) }
        : {})}
    />
  );
}

function LocalConnection({ onDemoGallery }: { onDemoGallery?: () => void }) {
  const [controller] = useState(
    () => new MobileController(localPort(), LOCAL_TEST_VERSION),
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  );
  const [gallery] = useState(() =>
    controller.createGallery(sqliteGalleryStore(LOCAL_GALLERY)),
  );
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [started, setStarted] = useState(false);
  const startedRef = useRef(false);
  useEffect(() => {
    let active = AppState.currentState === 'active';
    let online = true;
    const available = () => {
      if (!startedRef.current) return;
      if (active && online) void controller.reconnect();
      else controller.setAvailable(false);
    };
    const network = NetInfo.addEventListener((value) => {
      const next = value.isConnected !== false;
      if (next !== online) {
        online = next;
        available();
      }
    });
    const foreground = AppState.addEventListener('change', (value) => {
      const next = value === 'active';
      if (next !== active) {
        active = next;
        available();
      }
    });
    const timer = setInterval(() => {
      if (startedRef.current && active && online) void controller.pollDay();
    }, 30000);
    const captureTimer = setInterval(() => {
      if (startedRef.current && active && online) void controller.pollCapture();
    }, 3000);
    let checking = false;
    const healthTimer = setInterval(() => {
      if (!startedRef.current || !active || !online || checking) return;
      checking = true;
      void controller.checkConnection().finally(() => {
        checking = false;
      });
    }, 5000);
    return () => {
      network();
      foreground.remove();
      clearInterval(timer);
      clearInterval(captureTimer);
      clearInterval(healthTimer);
      controller.stop();
    };
  }, [controller]);
  function connect() {
    if (AppState.currentState !== 'active') return;
    startedRef.current = true;
    setStarted(true);
    void controller.reconnect();
  }
  const failure = state.phase === 'error' || state.phase === 'offline';
  const online = started && state.phase === 'today';
  // Each connection (and each new server day) applies deletions to the stored gallery.
  useEffect(() => {
    if (online) void gallery.sync();
  }, [gallery, online, state.day?.dayKey]);
  // §15 reminders follow the latest server day state; termination clears them.
  const [reminderRevision, setReminderRevision] = useState(0);
  const ended = ['ending', 'ended'].includes(state.phase);
  const pieces = state.board?.pieces.length ?? 0;
  useEffect(() => {
    if (!ended && !state.day) return;
    void applyReminders(
      planReminders(state.day, pieces, Date.now(), !ended),
    ).catch(() => {});
  }, [ended, state.day, pieces, reminderRevision]);
  return (
    <SafeAreaView style={styles.screen}>
      <View
        style={{
          backgroundColor: colors.cautionWash,
          paddingHorizontal: 20,
          paddingVertical: 8,
        }}
      >
        <Text
          style={[styles.muted, { color: colors.caution, fontWeight: '700' }]}
        >
          ローカル検証・実審査なし
        </Text>
      </View>
      <ProximityDiagnosticPanel />
      {started && (
        <>
          <ReportStatus state={state} controller={controller} />
          <BlockStatus state={state} controller={controller} />
        </>
      )}
      {galleryOpen ? (
        <Gallery
          gallery={gallery}
          online={online}
          onClose={() => setGalleryOpen(false)}
        />
      ) : started && state.phase === 'capture' ? (
        <>
          <View style={{ paddingHorizontal: 20, paddingTop: 16, gap: 10 }}>
            <Text style={styles.heading}>匿名認証で撮影準備ができました。</Text>
            <Note caution>
              紙に描いた図形など、人工素材だけを撮影してください。実在する人の写真や個人情報は使わないでください。画像と文章はMacへ保存します。
            </Note>
          </View>
          <Capture
            key={state.capture?.captureId}
            username={state.username}
            post={(base64, caption) => controller.post(base64, caption)}
          />
        </>
      ) : started && state.phase === 'today' ? (
        <LocalToday
          state={state}
          controller={controller}
          onGallery={() => setGalleryOpen(true)}
          {...(onDemoGallery ? { onDemoGallery } : {})}
          onNotificationsGranted={() => setReminderRevision((n) => n + 1)}
        />
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <Wordmark width={200} />
          <Text style={styles.title}>Macでローカル検証</Text>
          <Text style={styles.body}>
            端末とMacを同じWi-Fiにつないでください。人工素材の撮影と、Macでの仮審査・画像保存を試します。
          </Text>
          {!started && (
            <Button title="Macに接続して準備する" onPress={connect} />
          )}
          {onDemoGallery && (
            <Button
              secondary
              title="撮影用ギャラリー"
              onPress={onDemoGallery}
            />
          )}
          {started && state.phase === 'loading' && (
            <Note>Macへの接続と匿名認証を確認しています…</Note>
          )}
          {started &&
            !['loading', 'error', 'offline'].includes(state.phase) && (
              <Note>Macと接続できました。</Note>
            )}
          {started && state.phase === 'onboarding' && (
            <LocalOnboarding
              accept={(username) => controller.accept(username)}
            />
          )}
          {started && ['status', 'deleting'].includes(state.phase) && (
            <>
              <Note alert>
                {state.message || '保存済みの撮影状態を確認しました。'}
              </Note>
              {state.phase !== 'deleting' && (
                <Button
                  secondary
                  title={
                    state.capture?.status === 'rejected'
                      ? '撮り直す'
                      : 'もう一度確認する'
                  }
                  onPress={() => {
                    void (state.capture &&
                    ['error', 'processing', 'open'].includes(
                      state.capture.status,
                    )
                      ? controller.retryCapture()
                      : controller.refresh());
                  }}
                />
              )}
            </>
          )}
          {started && failure && (
            <>
              <Note caution alert>
                {state.message}
              </Note>
              <Text style={styles.body}>
                Macのサーバー、同じWi-Fi、ローカルネットワークの許可を確認してください。クラウドへの代替接続は行いません。
              </Text>
              <Button title="接続をやり直す" onPress={connect} />
            </>
          )}
          {(failure || !started) && (
            <Button
              secondary
              title="Galleryを見る（オフラインでも可）"
              onPress={() => setGalleryOpen(true)}
            />
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}
