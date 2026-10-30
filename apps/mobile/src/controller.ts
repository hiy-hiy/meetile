import { observeFit } from '@puzzle-sns/proximity-observer';
import { FitController } from './fit/controller';
import { GalleryController } from './gallery/controller';
import type { GalleryStore } from './gallery/store';
import type { ProximitySource } from './fit/source';
import {
  boardViewSchema,
  blockPhotoSchema,
  blockedPhotoSchema,
  type PendingBlock,
  captureStateSchema,
  dayStateSchema,
  deletedPhotoSchema,
  endedUseSchema,
  reportPhotoSchema,
  reportedPhotoSchema,
  signatureSchema,
  type BoardView,
  type CaptureState,
  type DayState,
  type PendingReport,
} from '@puzzle-sns/contracts';
export interface OwnPreferences {
  username: string;
  legalVersion: string | null;
  captureId: string | null;
  draft: { captureId: string; username: string; caption: string } | null;
  pendingReports?: PendingReport[] | undefined;
  pendingBlocks?: PendingBlock[] | undefined;
}
export interface ImageBatch {
  uris: Record<string, string>;
  release: () => void;
}
export interface MobilePort {
  initialize(): Promise<OwnPreferences>;
  savePreferences(value: OwnPreferences): Promise<void>;
  call(name: string, data: unknown): Promise<unknown>;
  subscribeState(changed: () => void, failed: () => void): () => void;
  subscribeBoard(
    boardId: string,
    changed: (view: unknown) => void,
    failed: () => void,
  ): () => void;
  /** Owner-only FIT progress document; absent in ports without FIT support. */
  subscribeFit?(
    changed: (view: unknown) => void,
    failed: () => void,
  ): () => void;
  loadImages(board: BoardView): Promise<ImageBatch>;
  checkConnection?(): Promise<void>;
  /** Opaque per-identity key for the on-device gallery; null while disconnected. */
  galleryOwner?(): Promise<string | null>;
  /** Erase own SecureStore data, private image cache and sign-in after termination was accepted. */
  eraseOwnData(): Promise<void>;
}
export interface Snapshot {
  phase:
    | 'loading'
    | 'onboarding'
    | 'capture'
    | 'status'
    | 'deleting'
    | 'ending'
    | 'ended'
    | 'today'
    | 'offline'
    | 'error';
  day: DayState | null;
  board: BoardView | null;
  capture: CaptureState | null;
  uris: Record<string, string>;
  message: string;
  username: string;
  reportState: 'idle' | 'sending' | 'pending' | 'sent';
  reportMessage: string;
  blockState: 'idle' | 'sending' | 'pending' | 'sent';
  blockMessage: string;
  endState:
    | 'idle'
    | 'sending'
    | 'unsent'
    | 'failed'
    | 'erasing'
    | 'erase-failed'
    | 'done';
  endMessage: string;
}
// Server refusal (e.g. a suspended subject); retrying will not change it.
const refused = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  typeof error.code === 'string' &&
  /(^|\/)permission-denied$/.test(error.code);
export class MobileController {
  private state: Snapshot = {
    phase: 'loading',
    day: null,
    board: null,
    capture: null,
    uris: {},
    message: '',
    username: '',
    reportState: 'idle',
    reportMessage: '',
    blockState: 'idle',
    blockMessage: '',
    endState: 'idle',
    endMessage: '',
  };
  private preferences: OwnPreferences = {
    username: '',
    legalVersion: null,
    captureId: null,
    draft: null,
  };
  private listeners = new Set<() => void>();
  private generation = 0;
  private boardGeneration = 0;
  private imageGeneration = 0;
  private connected = true;
  private initialized = false;
  private running = true;
  private creationPending = false;
  private deleting = false;
  // Account termination: `ending` while the request is in flight, `ended` once the server accepted it.
  private ending = false;
  private ended = false;
  private accessRecoveryAttempts = 0;
  // Serialize report and block submissions with deletion and reinitialization.
  private reporting = false;
  private unsavedSafety = false;
  private locallyHidden = new Set<string>();
  private preferenceWrites: Promise<void> = Promise.resolve();
  private unsubscribeState: (() => void) | null = null;
  private unsubscribeBoard: (() => void) | null = null;
  private images: ImageBatch | null = null;
  private galleryStore: GalleryStore | null = null;
  constructor(
    private readonly port: MobilePort,
    readonly legalVersion: string,
  ) {}
  /** Development-only calls that have no dedicated controller method. */
  callPort(name: string, data: unknown): Promise<unknown> {
    return this.port.call(name, data);
  }
  /** Finished days on this device; reports and blocks pending here stay masked. */
  createGallery(store: GalleryStore): GalleryController {
    this.galleryStore = store;
    return new GalleryController(
      this.port,
      store,
      async () => (this.port.galleryOwner ? this.port.galleryOwner() : null),
      (view) => this.maskSafetyHidden(view),
    );
  }
  /** One FIT attempt; the caller owns it and must `leave()` it when the screen closes. */
  createFit(source: ProximitySource | null): FitController {
    return observeFit(new FitController(this.port, source));
  }
  snapshot = (): Snapshot => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private update(value: Partial<Snapshot>) {
    this.state = { ...this.state, ...value };
    for (const listener of this.listeners) listener();
  }
  private savePreferences(): Promise<void> {
    // After termination nothing may recreate own SecureStore data.
    if (this.ended) return Promise.resolve();
    const value: OwnPreferences = {
      ...this.preferences,
      draft: this.preferences.draft ? { ...this.preferences.draft } : null,
      ...(this.preferences.pendingBlocks
        ? {
            pendingBlocks: this.preferences.pendingBlocks.map((value) => ({
              ...value,
            })),
          }
        : {}),
      ...(this.preferences.pendingReports
        ? {
            pendingReports: this.preferences.pendingReports.map((report) => ({
              ...report,
            })),
          }
        : {}),
    };
    const write = this.preferenceWrites
      .catch(() => {})
      .then(() => this.port.savePreferences(value));
    this.preferenceWrites = write;
    return write;
  }
  private maskSafetyHidden(board: BoardView): BoardView {
    return {
      ...board,
      pieces: board.pieces.map((piece) =>
        this.locallyHidden.has(piece.id)
          ? {
              ...piece,
              visibility: 'blank',
              photoRef: null,
              username: null,
              caption: null,
            }
          : piece,
      ),
    };
  }
  private clear() {
    this.boardGeneration++;
    this.imageGeneration++;
    this.unsubscribeBoard?.();
    this.unsubscribeBoard = null;
    const images = this.images;
    this.images = null;
    this.update({ board: null, uris: {} });
    try {
      images?.release();
    } catch {
      /* Remain blank; native startup retries private-cache purging. */
    }
  }
  async start(): Promise<void> {
    if (this.deleting || this.reporting || this.ending || this.ended) return;
    this.accessRecoveryAttempts = 0;
    if (!this.running) this.connected = true;
    this.running = true;
    const generation = ++this.generation;
    this.unsubscribeState?.();
    this.unsubscribeState = null;
    this.clear();
    this.update({ phase: 'loading', capture: null });
    try {
      if (this.unsavedSafety) {
        await this.savePreferences();
        this.unsavedSafety = false;
      }
      await this.preferenceWrites.catch(() => {});
      if (!this.running || !this.connected || generation !== this.generation)
        return;
      const preferences = await this.port.initialize();
      if (!this.running || !this.connected || generation !== this.generation)
        return;
      this.preferences = preferences;
      this.locallyHidden = new Set(
        [
          ...(preferences.pendingReports ?? []),
          ...(preferences.pendingBlocks ?? []),
        ].map((value) => value.pieceId),
      );
      this.update({
        blockState: preferences.pendingBlocks?.length ? 'pending' : 'idle',
        blockMessage: preferences.pendingBlocks?.length
          ? '再送待ちのブロックがあります。接続後に確認します。'
          : '',
        reportState: preferences.pendingReports?.length ? 'pending' : 'idle',
        reportMessage: preferences.pendingReports?.length
          ? '再送待ちの通報があります。対象は非表示にしています。'
          : '',
      });
      this.initialized = true;
      this.update({ username: this.preferences.username });
      await this.refresh();
      if (this.connected && this.preferences.pendingReports?.length)
        await this.retryReports();
    } catch {
      if (!this.running || !this.connected || generation !== this.generation)
        return;
      this.clear();
      this.update({
        phase: 'error',
        message:
          '接続できません。準備と通信状態を確認して、もう一度お試しください。',
      });
    }
  }
  async reconnect(): Promise<void> {
    this.connected = true;
    await this.start();
  }
  async checkConnection(): Promise<void> {
    if (
      this.ending ||
      this.ended ||
      !this.connected ||
      !this.initialized ||
      !this.port.checkConnection ||
      ['loading', 'offline', 'error'].includes(this.state.phase)
    )
      return;
    const generation = this.generation;
    try {
      await this.port.checkConnection();
    } catch {
      if (generation === this.generation) this.setAvailable(false);
    }
  }
  setAvailable(available: boolean) {
    if (this.ended) return;
    if (this.ending) {
      this.connected = available;
      return;
    }
    if (available) this.accessRecoveryAttempts = 0;
    this.connected = available;
    this.generation++;
    this.unsubscribeState?.();
    this.unsubscribeState = null;
    this.clear();
    if (!available)
      this.update({
        phase: 'offline',
        message: '通信できません。今日の写真とパズルは、接続後に利用できます。',
      });
    else void this.refresh();
  }
  async refresh(): Promise<void> {
    if (!this.connected || this.deleting || this.ending || this.ended) return;
    if (this.initialized && this.preferences.pendingBlocks?.length) {
      await this.retryBlocks();
      return;
    }
    if (!this.initialized) {
      await this.start();
      return;
    }
    const generation = ++this.generation;
    this.unsubscribeState?.();
    this.unsubscribeState = null;
    this.clear();
    this.update({ phase: 'loading' });
    try {
      const day = dayStateSchema.parse(await this.port.call('getDayState', {}));
      if (generation !== this.generation || !this.connected) return;
      this.update({ day });
      if (
        day.photoState === 'unavailable' &&
        (this.preferences.captureId || this.preferences.draft)
      ) {
        this.preferences = {
          ...this.preferences,
          captureId: null,
          draft: null,
        };
        await this.savePreferences();
        if (generation !== this.generation || !this.connected) return;
      }
      if (this.preferences.legalVersion !== this.legalVersion) {
        this.update({ phase: 'onboarding' });
        return;
      }
      if (day.photoState !== 'not-created' && day.boardId) {
        this.update({
          phase: 'today',
          capture: null,
          message:
            day.photoState === 'unavailable'
              ? '今日の写真は削除されています。次の日にまた撮影できます。'
              : '',
        });
        this.unsubscribeState = this.port.subscribeState(
          () => {
            void this.refreshBoard();
          },
          () => {
            if (generation === this.generation) this.recoverAccess();
          },
        );
        await this.refreshBoard();
        return;
      }
      if (day.photoState === 'unavailable') {
        this.update({
          phase: 'status',
          capture: null,
          message: '今日の写真は削除されています。次の日にまた撮影できます。',
        });
        return;
      }
      let capture: CaptureState | null = null;
      if (this.preferences.captureId) {
        capture = captureStateSchema.parse(
          await this.port.call('getCapture', {
            captureId: this.preferences.captureId,
          }),
        );
        if (
          capture.dayKey !== day.dayKey ||
          capture.status === 'expired' ||
          capture.status === 'rejected'
        ) {
          capture = null;
        }
      }
      if (!capture)
        capture = captureStateSchema.parse(
          await this.port.call('beginCapture', {}),
        );
      if (generation !== this.generation || !this.connected) return;
      this.preferences.captureId = capture.captureId;
      await this.savePreferences();
      const isDraft = this.preferences.draft?.captureId === capture.captureId;
      this.update({
        capture,
        phase: capture.status === 'open' && !isDraft ? 'capture' : 'status',
        message:
          capture.status === 'open' && isDraft
            ? '送信を完了できませんでした。もう一度確認できます。'
            : this.captureMessage(capture.status),
      });
    } catch {
      if (generation === this.generation) {
        this.clear();
        this.update({
          phase: 'error',
          message:
            '取得できません。通信状態を確認して、もう一度お試しください。',
        });
      }
    }
  }
  private captureMessage(status: CaptureState['status']) {
    return {
      open: '',
      processing: '写真を確認しています。',
      held: '確認中です。公開せず、確認が終わるまでお待ちください。',
      rejected: 'この写真や文章は投稿できません。撮り直してください。',
      approved: '今日のピースができました。',
      expired: '日付が変わりました。新しい日の写真を撮影してください。',
      error:
        '確認を続けられませんでした。時間をおいて、もう一度お試しください。',
    }[status];
  }
  private async refreshBoard() {
    if (
      this.deleting ||
      this.ending ||
      this.ended ||
      !this.connected ||
      this.preferences.pendingBlocks?.length
    )
      return;
    this.clear();
    const generation = this.boardGeneration;
    try {
      // Read current server membership; the old board ID must never drive a merge/display after a pointer update.
      const day = dayStateSchema.parse(await this.port.call('getDayState', {}));
      if (generation !== this.boardGeneration || !this.connected) return;
      if (
        day.dayKey !== this.state.day?.dayKey ||
        day.photoState !== this.state.day.photoState ||
        day.photoState === 'not-created' ||
        !day.boardId
      ) {
        await this.refresh();
        return;
      }
      const view = boardViewSchema.parse(
        await this.port.call('syncBoardView', { boardId: day.boardId }),
      );
      if (generation !== this.boardGeneration || !this.connected) return;
      if (view.boardId !== day.boardId || view.dayKey !== day.dayKey)
        throw new Error('Invalid board view');
      this.update({ day });
      this.unsubscribeBoard = this.port.subscribeBoard(
        view.boardId,
        (value) => {
          void this.showBoard(value, generation, true);
        },
        () => {
          if (generation === this.boardGeneration) this.recoverAccess();
        },
      );
      await this.showBoard(view, generation);
    } catch {
      if (generation === this.boardGeneration) {
        this.clear();
        this.update({
          phase: 'error',
          message: '盤面を更新できません。もう一度お試しください。',
        });
      }
    }
  }
  private recoverAccess() {
    if (this.deleting || this.ending || this.ended || !this.connected) return;
    if (this.accessRecoveryAttempts++ > 0) {
      this.setAvailable(false);
      return;
    }
    // A safety change invalidates old grants. Hide first, then ask the server
    // for fresh membership/permissions; never retain the last visible photo.
    void this.refresh();
  }
  private async showBoard(
    value: unknown,
    generation: number,
    subscribed = false,
  ) {
    if (
      generation !== this.boardGeneration ||
      !this.connected ||
      this.preferences.pendingBlocks?.length
    )
      return;
    const imageGeneration = ++this.imageGeneration;
    const previous = this.images;
    this.images = null;
    this.update({ uris: {} });
    try {
      previous?.release();
      const board = this.maskSafetyHidden(boardViewSchema.parse(value));
      if (
        board.boardId !== this.state.day?.boardId ||
        board.dayKey !== this.state.day.dayKey
      )
        throw new Error('Invalid board view');
      if (subscribed) this.accessRecoveryAttempts = 0;
      this.update({ board, uris: {} });
      const images = await this.port.loadImages(board);
      if (
        generation !== this.boardGeneration ||
        imageGeneration !== this.imageGeneration ||
        !this.connected
      ) {
        images.release();
        return;
      }
      this.images = images;
      this.update({ board, uris: images.uris });
    } catch {
      if (imageGeneration === this.imageGeneration) {
        this.clear();
        this.update({
          phase: 'error',
          message: '写真を取得できません。もう一度お試しください。',
        });
      }
    }
  }
  async accept(username: string): Promise<void> {
    const signature = signatureSchema.parse(username);
    await this.port.call('acceptOnboarding', {
      age16OrOlder: true,
      accepted: true,
      legalVersion: this.legalVersion,
    });
    this.preferences = {
      ...this.preferences,
      username: signature,
      legalVersion: this.legalVersion,
    };
    await this.savePreferences();
    this.update({ username: signature });
    await this.refresh();
  }
  async deleteOwnPhoto(pieceId: string): Promise<void> {
    if (
      this.deleting ||
      this.reporting ||
      this.ending ||
      !this.connected ||
      this.state.phase !== 'today' ||
      this.state.day?.ownPieceId !== pieceId ||
      !this.state.board?.pieces.some(
        (piece) => piece.id === pieceId && piece.visibility === 'visible',
      )
    )
      return;
    this.deleting = true;
    this.generation++;
    this.creationPending = false;
    this.unsubscribeState?.();
    this.unsubscribeState = null;
    this.clear();
    this.update({
      phase: 'deleting',
      capture: null,
      message: '写真を削除しています。',
    });
    let deleted = false;
    try {
      deletedPhotoSchema.parse(
        await this.port.call('deleteOwnPhoto', { pieceId }),
      );
      deleted = true;
    } catch {
      if (this.running && this.connected)
        this.update({
          phase: 'error',
          message:
            '削除の結果を確認できません。接続を確認して、もう一度状態を確認してください。',
        });
    } finally {
      this.deleting = false;
    }
    if (deleted && this.running && this.connected) await this.refresh();
  }
  async reportPhoto(
    pieceId: string,
    reason: PendingReport['reason'],
  ): Promise<void> {
    if (
      this.reporting ||
      this.deleting ||
      this.ending ||
      this.state.phase !== 'today' ||
      !this.connected ||
      pieceId === this.state.day?.ownPieceId ||
      !this.state.board?.pieces.some(
        (piece) => piece.id === pieceId && piece.visibility === 'visible',
      )
    )
      return;
    const input = reportPhotoSchema.parse({ pieceId, reason });
    const view = this.state.board;
    this.preferences = {
      ...this.preferences,
      pendingReports: [
        ...(this.preferences.pendingReports ?? []).filter(
          (report) => report.pieceId !== pieceId,
        ),
        input,
      ],
    };
    this.unsavedSafety = true;
    this.locallyHidden.add(pieceId);
    this.generation++;
    this.unsubscribeState?.();
    this.unsubscribeState = null;
    this.clear();
    this.update({
      phase: 'today',
      board: this.maskSafetyHidden(view),
      reportState: 'sending',
      reportMessage: '通報を送信しています。対象は非表示にしています。',
    });
    await this.retryReports();
  }
  async retryReports(): Promise<void> {
    if (
      this.ended ||
      this.reporting ||
      this.deleting ||
      !this.preferences.pendingReports?.length
    )
      return;
    this.reporting = true;
    this.update({
      reportState: 'sending',
      reportMessage: '通報を送信しています。対象は非表示にしています。',
    });
    try {
      await this.savePreferences();
      this.unsavedSafety = false;
      if (!this.connected) throw new Error('Unavailable');
      for (const report of [...this.preferences.pendingReports]) {
        reportedPhotoSchema.parse(await this.port.call('reportPhoto', report));
        const previous = this.preferences;
        this.preferences = {
          ...this.preferences,
          pendingReports: (this.preferences.pendingReports ?? []).filter(
            (value) => value.pieceId !== report.pieceId,
          ),
        };
        try {
          await this.savePreferences();
        } catch (error) {
          this.preferences = {
            ...this.preferences,
            pendingReports: previous.pendingReports ?? [],
          };
          this.unsavedSafety = true;
          throw error;
        }
      }
      if (!this.ended)
        this.update({
          reportState: 'sent',
          reportMessage: '通報を送信しました。対象は非表示にしています。',
        });
    } catch {
      if (!this.ended)
        this.update({
          reportState: 'pending',
          reportMessage:
            '通報の送信完了を確認できません。対象を非表示にしたまま、接続後に再送できます。',
        });
    } finally {
      this.reporting = false;
    }
    if (this.running && this.connected) await this.refresh();
  }
  async blockPhoto(pieceId: string): Promise<void> {
    if (
      this.reporting ||
      this.deleting ||
      this.ending ||
      !this.connected ||
      this.state.phase !== 'today' ||
      pieceId === this.state.day?.ownPieceId ||
      !this.state.board?.pieces.some(
        (piece) => piece.id === pieceId && piece.visibility === 'visible',
      )
    )
      return;
    const input = blockPhotoSchema.parse({ pieceId });
    const view = this.state.board;
    this.preferences = {
      ...this.preferences,
      pendingBlocks: [
        ...(this.preferences.pendingBlocks ?? []).filter(
          (value) => value.pieceId !== pieceId,
        ),
        input,
      ],
    };
    this.unsavedSafety = true;
    this.locallyHidden.add(pieceId);
    this.generation++;
    this.unsubscribeState?.();
    this.unsubscribeState = null;
    this.clear();
    this.update({
      phase: 'today',
      board: this.maskSafetyHidden(view),
      blockState: 'sending',
      blockMessage: 'ブロックを送信しています。対象は非表示にしています。',
    });
    await this.retryBlocks();
  }
  async retryBlocks(): Promise<void> {
    if (
      this.ended ||
      this.reporting ||
      this.deleting ||
      !this.preferences.pendingBlocks?.length
    )
      return;
    this.reporting = true;
    this.update({
      blockState: 'sending',
      blockMessage: 'ブロックを送信しています。対象は非表示にしています。',
    });
    try {
      await this.savePreferences();
      this.unsavedSafety = false;
      if (!this.connected) throw new Error('Unavailable');
      for (const block of [...this.preferences.pendingBlocks]) {
        blockedPhotoSchema.parse(await this.port.call('blockPhoto', block));
        const previous = this.preferences;
        this.preferences = {
          ...this.preferences,
          pendingBlocks: (this.preferences.pendingBlocks ?? []).filter(
            (value) => value.pieceId !== block.pieceId,
          ),
        };
        try {
          await this.savePreferences();
        } catch (error) {
          this.preferences = {
            ...this.preferences,
            pendingBlocks: previous.pendingBlocks ?? [],
          };
          this.unsavedSafety = true;
          throw error;
        }
      }
      if (!this.ended)
        this.update({
          blockState: 'sent',
          blockMessage:
            'ブロックしました。今後も互いの写真・署名・キャプションを非表示にします。',
        });
    } catch {
      // A pending block can refer to yesterday's piece. Until the server has
      // resolved its private owner, do not download today's possibly new ID.
      this.clear();
      if (this.ended) return;
      this.update({
        blockState: 'pending',
        blockMessage:
          'ブロックの完了を確認できません。写真を非表示にしたまま、接続後に再送できます。',
        ...(this.running && this.connected
          ? {
              phase: 'error' as const,
              message:
                '安全設定を確認できません。接続後にブロックを再送してください。',
            }
          : {}),
      });
    } finally {
      this.reporting = false;
    }
    if (
      this.running &&
      this.connected &&
      !this.preferences.pendingBlocks?.length
    )
      await this.refresh();
  }
  async setUsername(username: string): Promise<void> {
    if (this.ended) return;
    const value = signatureSchema.parse(username);
    this.preferences.username = value;
    await this.savePreferences();
    this.update({ username: value });
  }
  async post(base64: string, caption: string): Promise<void> {
    const capture = this.state.capture;
    if (
      this.ending ||
      this.ended ||
      !capture ||
      !this.connected ||
      capture.status !== 'open' ||
      this.state.phase !== 'capture'
    )
      return;
    const generation = this.generation;
    const username = this.preferences.username;
    this.update({ phase: 'status', message: '写真を確認しています。' });
    try {
      this.preferences.draft = {
        captureId: capture.captureId,
        username,
        caption,
      };
      await this.savePreferences();
      await this.port.call('uploadCapture', {
        captureId: capture.captureId,
        base64,
      });
      const result = captureStateSchema.parse(
        await this.port.call('submitCapture', {
          captureId: capture.captureId,
          username,
          caption,
        }),
      );
      if (!this.connected || generation !== this.generation) return;
      this.update({
        capture: result,
        phase: 'status',
        message: this.captureMessage(result.status),
      });
      if (result.status === 'approved') {
        this.creationPending = true;
        await this.refresh();
      }
    } catch {
      if (generation === this.generation && this.connected)
        this.update({
          phase: 'error',
          message: '写真を送信できません。通信状態を確認してお試しください。',
        });
    }
  }
  async retryCapture(): Promise<void> {
    const capture = this.state.capture;
    if (!capture || !this.connected) return;
    const generation = this.generation;
    try {
      const draft = this.preferences.draft;
      const username =
        capture.username ??
        (draft?.captureId === capture.captureId ? draft.username : null);
      const caption =
        capture.caption ??
        (draft?.captureId === capture.captureId ? draft.caption : null);
      if (username === null || caption === null) {
        await this.refresh();
        return;
      }
      const result = captureStateSchema.parse(
        await this.port.call('submitCapture', {
          captureId: capture.captureId,
          username,
          caption,
        }),
      );
      if (generation !== this.generation || !this.connected) return;
      if (result.status === 'open') {
        this.preferences.draft = null;
        await this.savePreferences();
      }
      this.update({
        capture: result,
        message: this.captureMessage(result.status),
      });
      if (result.status === 'approved') this.creationPending = true;
      if (result.status === 'open' || result.status === 'approved')
        await this.refresh();
    } catch {
      if (generation === this.generation && this.connected)
        this.update({
          phase: 'error',
          message: '確認を続けられませんでした。もう一度お試しください。',
        });
    }
  }
  async pollCapture() {
    const capture = this.state.capture;
    const generation = this.generation;
    if (!capture || !this.connected || capture.status !== 'processing') return;
    try {
      const result = captureStateSchema.parse(
        await this.port.call('getCapture', { captureId: capture.captureId }),
      );
      if (generation !== this.generation || !this.connected) return;
      this.update({
        capture: result,
        message: this.captureMessage(result.status),
      });
      if (result.status === 'approved') await this.refresh();
    } catch {
      if (generation === this.generation) this.setAvailable(false);
    }
  }
  async pollDay() {
    if (this.ending || this.ended) return;
    if (
      this.running &&
      this.connected &&
      this.initialized &&
      this.preferences.pendingBlocks?.length
    ) {
      await this.retryBlocks();
      return;
    }
    const generation = this.generation;
    if (
      !this.connected ||
      !this.initialized ||
      this.deleting ||
      this.ending ||
      ['loading', 'onboarding', 'offline', 'error'].includes(this.state.phase)
    )
      return;
    try {
      const day = dayStateSchema.parse(await this.port.call('getDayState', {}));
      if (generation !== this.generation || !this.connected) return;
      const previous = this.state.day;
      if (
        day.dayKey !== previous?.dayKey ||
        day.photoState !== previous.photoState ||
        day.boardId !== previous.boardId
      )
        await this.refresh();
      else this.update({ day });
      if (this.connected && this.preferences.pendingReports?.length)
        void this.retryReports();
    } catch {
      if (generation === this.generation) this.setAvailable(false);
    }
  }
  /**
   * Irreversible. Device data is erased only after the server accepted the
   * termination; unsent reports/blocks are flushed first because they would be
   * lost with the device data. If some stay unsent, ask before discarding them.
   */
  async endUse(discardUnsent = false): Promise<void> {
    if (this.ending || this.ended) return;
    if (
      this.deleting ||
      this.reporting ||
      !this.connected ||
      !this.initialized
    ) {
      // Never ignore a deletion request silently.
      this.update({
        endState: 'failed',
        endMessage:
          '今は利用終了を送信できません。通信と送信中の操作が終わってから、もう一度お試しください。',
      });
      return;
    }
    this.ending = true;
    this.update({
      endState: 'sending',
      endMessage: '利用終了を送信しています。',
    });
    try {
      await this.retryReports();
      await this.retryBlocks();
      const unsent =
        (this.preferences.pendingReports?.length ?? 0) +
        (this.preferences.pendingBlocks?.length ?? 0);
      if (unsent && !discardUnsent) {
        this.ending = false;
        this.update({
          endState: 'unsent',
          endMessage:
            '未送信の通報またはブロックがあります。このまま終了すると破棄されます。',
        });
        if (this.running && this.connected) await this.refresh();
        return;
      }
      this.generation++;
      this.creationPending = false;
      this.unsubscribeState?.();
      this.unsubscribeState = null;
      this.clear();
      this.update({
        phase: 'ending',
        capture: null,
        message: '利用終了を処理しています。',
      });
      if (!this.connected) throw new Error('Unavailable');
      endedUseSchema.parse(await this.port.call('endUse', { confirm: true }));
    } catch (error: unknown) {
      this.ending = false;
      this.update({
        endState: 'failed',
        endMessage: refused(error)
          ? '現在、アプリからは利用終了を受け付けられません。端末のデータは消していません。'
          : '利用終了の結果を確認できません。端末のデータは消していません。通信状態を確認して、もう一度お試しください。',
      });
      if (!this.connected)
        this.update({
          phase: 'offline',
          message:
            '通信できません。今日の写真とパズルは、接続後に利用できます。',
        });
      else if (this.running) await this.refresh();
      return;
    }
    // Accepted: stop every further request and never recreate own data.
    this.ending = false;
    this.ended = true;
    this.running = false;
    this.connected = false;
    this.initialized = false;
    this.generation++;
    this.preferences = {
      username: '',
      legalVersion: null,
      captureId: null,
      draft: null,
    };
    this.locallyHidden = new Set();
    this.update({
      phase: 'ended',
      day: null,
      capture: null,
      username: '',
      message: '',
      reportState: 'idle',
      reportMessage: '',
      blockState: 'idle',
      blockMessage: '',
    });
    await this.eraseDevice();
  }
  /** Cancel from the confirmation: forget a previous failure/unsent notice. */
  dismissEndUse(): void {
    if (!this.ending && !this.ended)
      this.update({ endState: 'idle', endMessage: '' });
  }
  async retryErase(): Promise<void> {
    if (this.ended && this.state.endState === 'erase-failed')
      await this.eraseDevice();
  }
  private async eraseDevice(): Promise<void> {
    this.update({
      endState: 'erasing',
      endMessage: 'この端末のデータを消去しています。',
    });
    try {
      // A queued preference write must finish first, or it could recreate data.
      await this.preferenceWrites.catch(() => {});
      // The port deletes the gallery folder; its database must be closed first.
      await this.galleryStore?.close().catch(() => {});
      await this.port.eraseOwnData();
      this.update({
        endState: 'done',
        endMessage:
          '利用を終了しました。写真と本人用のデータは復元できません。アプリを閉じてください。',
      });
    } catch {
      this.update({
        endState: 'erase-failed',
        endMessage:
          '利用終了は受け付けられましたが、この端末のデータを消去しきれませんでした。もう一度消去してください。',
      });
    }
  }
  consumeCreation(): boolean {
    const pending = this.creationPending;
    this.creationPending = false;
    return pending;
  }
  stop() {
    this.running = false;
    this.generation++;
    this.connected = false;
    this.unsubscribeState?.();
    this.unsubscribeState = null;
    this.clear();
  }
}
