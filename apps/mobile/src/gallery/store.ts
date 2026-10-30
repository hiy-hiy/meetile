import { Directory, File, Paths } from 'expo-file-system';
import type { SQLiteDatabase } from 'expo-sqlite';
import { hasNativeModule } from '../native-available';
import { boardViewSchema, type BoardView } from '@puzzle-sns/contracts';

export interface GalleryEntry {
  view: BoardView;
  /** Local file URIs of the pieces that were visible at the last sync. */
  uris: Record<string, string>;
}
export interface GalleryStore {
  /** Newest day first; works offline. */
  list(): Promise<GalleryEntry[]>;
  /**
   * Blanked pieces lose their local image before the stored view changes. Visible pieces without
   * a new source keep their earlier file, so a failed download never removes finished art.
   */
  save(view: BoardView, sources: Record<string, string>): Promise<void>;
  /** Before syncing: a different identity's gallery is wiped (e.g. after a local reset). */
  claim(owner: string): Promise<void>;
  close(): Promise<void>;
}

/** The DB and images share one folder, so erasing own data is a single folder delete. */
export function galleryDirectory(name: string): Directory {
  return new Directory(Paths.document, name);
}

/**
 * Finished boards in SQLite plus image files under the app's document folder (not the cache,
 * which the OS may purge). It opens without a connection so the gallery works offline; the
 * opaque owner key is checked by `claim` once the identity is known.
 */
export function sqliteGalleryStore(name: string): GalleryStore {
  let folderRoot: Directory | null = null;
  const rootFolder = () => (folderRoot ??= galleryDirectory(name));
  let opening: Promise<SQLiteDatabase> | null = null;
  let closed = false;
  const open = () =>
    (opening ??= (async () => {
      // Loaded lazily: an older development binary without the native module keeps working.
      if (!hasNativeModule('ExpoSQLite'))
        throw new Error('Gallery storage unavailable in this build');
      const SQLite = await import('expo-sqlite');
      const root = rootFolder();
      root.create({ intermediates: true, idempotent: true });
      const db = await SQLite.openDatabaseAsync('gallery.db', {}, root.uri);
      await db.execAsync(
        `CREATE TABLE IF NOT EXISTS boards (board_id TEXT PRIMARY KEY NOT NULL, day_key TEXT NOT NULL, view TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);`,
      );
      return db;
    })());
  const folder = (boardId: string) => new Directory(rootFolder(), boardId);
  return {
    async list() {
      if (closed) return [];
      const db = await open();
      const rows = await db.getAllAsync<{ view: string }>(
        'SELECT view FROM boards ORDER BY day_key DESC',
      );
      return rows.flatMap((row) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.view);
        } catch {
          return [];
        }
        const view = boardViewSchema.safeParse(parsed);
        if (!view.success) return [];
        const uris: Record<string, string> = {};
        for (const piece of view.data.pieces) {
          if (piece.visibility !== 'visible') continue;
          const file = new File(folder(view.data.boardId), `${piece.id}.jpg`);
          if (file.exists) uris[piece.id] = file.uri;
        }
        return [{ view: view.data, uris }];
      });
    },
    async save(value, sources) {
      if (closed) return;
      const view = boardViewSchema.parse(value);
      const db = await open();
      const directory = folder(view.boardId);
      directory.create({ intermediates: true, idempotent: true });
      for (const piece of view.pieces) {
        const target = new File(directory, `${piece.id}.jpg`);
        if (piece.visibility !== 'visible') {
          if (target.exists) target.delete();
          continue;
        }
        const source = sources[piece.id];
        if (!source) continue;
        if (target.exists) target.delete();
        // The row is written only after every visible image has been copied.
        await new File(source).copy(target);
      }
      await db.runAsync(
        'INSERT OR REPLACE INTO boards (board_id, day_key, view) VALUES (?, ?, ?)',
        view.boardId,
        view.dayKey,
        JSON.stringify(view),
      );
    },
    async claim(owner) {
      if (closed) return;
      const db = await open();
      const stored = await db.getFirstAsync<{ value: string }>(
        'SELECT value FROM meta WHERE key = ?',
        'owner',
      );
      if (stored?.value === owner) return;
      await db.execAsync('DELETE FROM boards;');
      for (const item of rootFolder().list())
        if (item instanceof Directory) item.delete();
      await db.runAsync(
        'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)',
        'owner',
        owner,
      );
    },
    async close() {
      closed = true;
      const pending = opening;
      opening = null;
      if (pending) await (await pending.catch(() => null))?.closeAsync();
    },
  };
}
