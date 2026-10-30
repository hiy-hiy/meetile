import {
  boardViewSchema,
  galleryListSchema,
  type BoardView,
} from '@puzzle-sns/contracts';
import type { MobilePort } from '../controller';
import type { GalleryEntry, GalleryStore } from './store';

export interface GallerySnapshot {
  status: 'idle' | 'loading' | 'syncing' | 'ready' | 'offline';
  entries: GalleryEntry[];
}

/**
 * Finished days only. The server lists the caller's boards and re-projects each one, so photo
 * deletions and blocks reach the stored copy on the next connection; offline, stored art stays.
 */
export class GalleryController {
  private state: GallerySnapshot = { status: 'idle', entries: [] };
  private listeners = new Set<() => void>();
  private syncing: Promise<void> | null = null;
  constructor(
    private readonly port: Pick<MobilePort, 'call' | 'loadImages'>,
    private readonly store: GalleryStore,
    private readonly owner: () => Promise<string | null>,
    private readonly mask: (view: BoardView) => BoardView = (view) => view,
  ) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(value: Partial<GallerySnapshot>) {
    this.state = { ...this.state, ...value };
    for (const listener of this.listeners) listener();
  }
  /** Reading the store never hides an ongoing sync or a known offline result. */
  private settled(): GallerySnapshot['status'] {
    return ['idle', 'loading'].includes(this.state.status)
      ? 'ready'
      : this.state.status;
  }
  async load(): Promise<void> {
    if (this.state.status === 'idle') this.update({ status: 'loading' });
    try {
      const entries = await this.store.list();
      this.update({ entries, status: this.settled() });
    } catch {
      this.update({ status: this.settled() });
    }
  }
  sync(): Promise<void> {
    return (this.syncing ??= this.run().finally(() => {
      this.syncing = null;
    }));
  }
  private async run(): Promise<void> {
    this.update({ status: 'syncing' });
    try {
      const owner = await this.owner();
      if (!owner) throw new Error('Gallery identity unavailable');
      await this.store.claim(owner);
      const list = galleryListSchema.parse(
        await this.port.call('listGallery', {}),
      );
      for (const entry of list.entries) await this.syncOne(entry);
      this.update({ status: 'ready' });
    } catch {
      this.update({ status: 'offline' });
    }
    await this.load();
  }
  private async syncOne(entry: { boardId: string; dayKey: string }) {
    let view: BoardView;
    try {
      view = boardViewSchema.parse(
        await this.port.call('syncBoardView', { boardId: entry.boardId }),
      );
    } catch {
      return; // Keep the stored copy; the next connection retries.
    }
    if (view.boardId !== entry.boardId || view.dayKey !== entry.dayKey) return;
    const masked = this.mask(view);
    try {
      const images = await this.port.loadImages(masked);
      try {
        await this.store.save(masked, images.uris);
      } finally {
        images.release();
      }
    } catch {
      // Images failed: still apply blanking to the stored copy, keeping earlier visible files.
      await this.store.save(masked, {});
    }
  }
}
