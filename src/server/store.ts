import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  ActivityOutcome,
  ExclusionKind,
  ExecutablePlan,
  FileError,
  HistoryRow,
  InspectionReport,
  Job,
  JobPhase,
  JobStatus,
  LibraryItem,
  ReviewItem,
  ReviewStatus,
  Settings,
  Suggestion,
  VideoTarget,
} from "./types.ts";
import { parseAudioMix, parseVideoTarget, type AudioMix } from "./types.ts";
import { normalizeInspection } from "./inspect.ts";
import { displayTitle, displayTitleForFile, tokenize } from "./titles.ts";
import { parseStoredSettings } from "./settings.ts";
import type { SuggestionFilters } from "./suggestion-filters.ts";
import { suggestionTrackComparison } from "./tracks.ts";
import { parseHardwareInfo, parseNodeRole, type ClusterNode } from "./cluster.ts";

export type Page<T> = { items: T[]; nextOffset: number | null; total: number; pendingCount?: number; finishedCount?: number };

export type LibrarySnapshot = {
  item: LibraryItem;
  report: InspectionReport | null;
  suggestion: Suggestion | null;
  error: string | null;
};

type JobPlan = Suggestion | ExecutablePlan;

export type SeriesSummaryRecord = {
  instanceId: string;
  instanceName: string;
  arrSeriesId: number;
  showTitle: string;
  episodeCount: number;
  healthyCount: number;
  suggestionCount: number;
  videoTarget: VideoTarget | null;
  audioMix: AudioMix | null;
};

export type StoredInstance = {
  id: string;
  kind: "radarr" | "sonarr" | "plex" | "jellyfin";
  name: string;
  url: string;
  secret: string | null;
  enabled: boolean;
};

export class Store {
  readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS instances (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        secret TEXT,
        enabled INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS library_items (
        id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        arr_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        show_title TEXT,
        season INTEGER,
        episode INTEGER,
        episode_title TEXT,
        path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        quality TEXT NOT NULL DEFAULT '',
        resolution TEXT NOT NULL DEFAULT '',
        profile TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]',
        poster_remote TEXT,
        poster_bytes BLOB,
        size_exempt INTEGER NOT NULL DEFAULT 0,
        first_seen_at INTEGER NOT NULL DEFAULT 0,
        file_changed_at INTEGER NOT NULL DEFAULT 0,
        kept_size_bytes INTEGER NOT NULL DEFAULT 0,
        UNIQUE(instance_id, type, arr_id)
      );
      CREATE TABLE IF NOT EXISTS inspections (
        item_id TEXT PRIMARY KEY,
        source_sig TEXT NOT NULL,
        report TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS suggestions (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        dismissed INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        suggestion_id TEXT,
        status TEXT NOT NULL,
        phase TEXT NOT NULL,
        progress REAL NOT NULL DEFAULT 0,
        error TEXT,
        warning TEXT,
        run_now INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL,
        plan TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        status TEXT NOT NULL,
        flagged INTEGER NOT NULL DEFAULT 0,
        flag_reason TEXT,
        source_path TEXT NOT NULL,
        sidecar_path TEXT NOT NULL,
        compare TEXT NOT NULL,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS file_errors (
        path TEXT PRIMARY KEY,
        item_id TEXT,
        reason TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS history (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        bytes_saved INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS exclusions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS library_roots (
        instance_id TEXT NOT NULL,
        path TEXT NOT NULL,
        PRIMARY KEY (instance_id, path)
      );
      CREATE TABLE IF NOT EXISTS inspect_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        walking INTEGER NOT NULL DEFAULT 0,
        pending INTEGER NOT NULL DEFAULT 0,
        inspected INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO inspect_state (id, walking, pending, inspected, failed) VALUES (1, 0, 0, 0, 0);
      CREATE TABLE IF NOT EXISTS series_preferences (
        instance_id TEXT NOT NULL,
        arr_series_id INTEGER NOT NULL,
        video_target TEXT,
        audio_mix TEXT,
        PRIMARY KEY (instance_id, arr_series_id)
      );
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        last_seen INTEGER NOT NULL,
        hardware TEXT NOT NULL,
        concurrency INTEGER NOT NULL DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 1,
        version TEXT NOT NULL DEFAULT '',
        current_job_id TEXT
      );
    `);
    this.ensureColumn("jobs", "position", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("jobs", "phase", "TEXT NOT NULL DEFAULT 'queued'");
    this.ensureColumn("jobs", "progress", "REAL NOT NULL DEFAULT 0");
    this.ensureColumn("jobs", "warning", "TEXT");
    this.ensureColumn("jobs", "run_now", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("jobs", "plan", "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn("jobs", "suggestion_id", "TEXT");
    this.ensureColumn("jobs", "error", "TEXT");
    this.ensureColumn("jobs", "created_at", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("jobs", "write_mode", "TEXT NOT NULL DEFAULT 'sidecar'");
    this.ensureColumn("jobs", "promote_error", "TEXT");
    this.ensureColumn("jobs", "queue_visible", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("jobs", "log", "TEXT");
    this.ensureColumn("jobs", "assigned_node_id", "TEXT");
    this.ensureColumn("jobs", "node_id", "TEXT");
    this.ensureColumn("jobs", "lease_until", "INTEGER");
    this.ensureColumn("jobs", "lease_token", "TEXT");
    this.ensureColumn("jobs", "started_at", "INTEGER");
    this.ensureColumn("library_items", "arr_series_id", "INTEGER");
    this.ensureColumn("library_items", "arr_episode_file_id", "INTEGER");
    this.ensureColumn("library_items", "first_seen_at", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("library_items", "file_changed_at", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("library_items", "kept_size_bytes", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("library_items", "video_target", "TEXT");
    this.ensureColumn("series_preferences", "audio_mix", "TEXT");
    this.migrateSeriesVideoTargets();
    this.db.prepare("DELETE FROM settings WHERE key = 'github_token'").run();
  }

  private migrateSeriesVideoTargets(): void {
    const legacy = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'series_video_targets'",
    ).get() as { name: string } | undefined;
    if (!legacy) return;
    this.db.exec(`
      INSERT OR IGNORE INTO series_preferences (instance_id, arr_series_id, video_target)
      SELECT instance_id, arr_series_id, video_target FROM series_video_targets;
      DROP TABLE series_video_targets;
    `);
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((row) => row.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  probeWrite(value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('probe', ?)").run(value);
  }

  probeRead(): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'probe'").get() as { value: string } | undefined;
    return row?.value;
  }

  getSettings(): Settings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'app'").get() as { value: string } | undefined;
    if (!row) return parseStoredSettings({});
    try {
      return parseStoredSettings(JSON.parse(row.value));
    } catch {
      return parseStoredSettings({});
    }
  }

  saveSettings(next: Settings): void {
    this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('app', ?)").run(JSON.stringify(next));
  }

  userCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
  }

  createUser(username: string, passwordHash: string): void {
    this.db.prepare("INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)").run(randomUUID(), username, passwordHash);
  }

  findUser(username: string): { id: string; username: string; passwordHash: string } | undefined {
    const row = this.db.prepare("SELECT id, username, password_hash FROM users WHERE username = ?").get(username) as
      | { id: string; username: string; password_hash: string }
      | undefined;
    return row ? { id: row.id, username: row.username, passwordHash: row.password_hash } : undefined;
  }

  onlyUser(): { id: string; username: string; passwordHash: string } | undefined {
    const row = this.db.prepare("SELECT id, username, password_hash FROM users LIMIT 1").get() as
      | { id: string; username: string; password_hash: string }
      | undefined;
    return row ? { id: row.id, username: row.username, passwordHash: row.password_hash } : undefined;
  }

  updateUser(id: string, username: string, passwordHash: string): void {
    this.db.prepare("UPDATE users SET username = ?, password_hash = ? WHERE id = ?").run(username, passwordHash, id);
  }

  createSession(userId: string, ttlMs: number, now = Date.now()): string {
    const id = randomUUID();
    this.db.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)").run(id, userId, now + ttlMs);
    return id;
  }

  getSession(id: string, now = Date.now()): { userId: string } | undefined {
    const row = this.db.prepare("SELECT user_id, expires_at FROM sessions WHERE id = ?").get(id) as
      | { user_id: string; expires_at: number }
      | undefined;
    if (!row || row.expires_at <= now) return undefined;
    return { userId: row.user_id };
  }

  deleteSession(id: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  deleteUserSessions(userId: string): void {
    this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }

  upsertInstance(row: {
    id?: string;
    kind: StoredInstance["kind"];
    name: string;
    url: string;
    secret?: string | null;
    enabled: boolean;
  }): string {
    const id = row.id ?? randomUUID();
    const existing = this.db.prepare("SELECT secret FROM instances WHERE id = ?").get(id) as { secret: string | null } | undefined;
    const secret = row.secret === undefined ? existing?.secret ?? null : row.secret;
    this.db
      .prepare(
        `INSERT INTO instances (id, kind, name, url, secret, enabled) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, name=excluded.name, url=excluded.url, secret=excluded.secret, enabled=excluded.enabled`,
      )
      .run(id, row.kind, row.name, row.url, secret, row.enabled ? 1 : 0);
    return id;
  }

  listInstances(): StoredInstance[] {
    return (this.db.prepare("SELECT * FROM instances").all() as Record<string, unknown>[]).map(mapInstance);
  }

  getInstance(id: string): StoredInstance | undefined {
    const row = this.db.prepare("SELECT * FROM instances WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapInstance(row) : undefined;
  }

  deleteInstance(id: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM library_roots WHERE instance_id = ?").run(id);
      this.db.prepare("DELETE FROM series_preferences WHERE instance_id = ?").run(id);
      this.db.prepare("DELETE FROM instances WHERE id = ?").run(id);
    })();
  }

  replaceLibraryRoots(instanceId: string, paths: string[]): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM library_roots WHERE instance_id = ?").run(instanceId);
      const insert = this.db.prepare("INSERT INTO library_roots (instance_id, path) VALUES (?, ?)");
      for (const path of new Set(paths)) insert.run(instanceId, path);
    })();
  }

  listLibraryRoots(instanceId?: string): string[] {
    const rows = instanceId
      ? this.db.prepare("SELECT path FROM library_roots WHERE instance_id = ? ORDER BY path").all(instanceId)
      : this.db.prepare("SELECT path FROM library_roots ORDER BY path").all();
    return (rows as Array<{ path: string }>).map((row) => row.path);
  }

  upsertItem(item: Omit<LibraryItem, "hasPoster" | "instanceName"> & { posterBytes?: Buffer | null }): string {
    const previous = this.getItem(item.id);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO library_items (id, instance_id, arr_id, arr_series_id, arr_episode_file_id, type, title, show_title, season, episode, episode_title, path, size_bytes, quality, resolution, profile, tags, poster_remote, poster_bytes, size_exempt, first_seen_at, file_changed_at)
         VALUES (@id, @instanceId, @arrId, @arrSeriesId, @arrEpisodeFileId, @type, @title, @showTitle, @season, @episode, @episodeTitle, @path, @sizeBytes, @quality, @resolution, @profile, @tags, @posterRemoteUrl, @posterBytes, @sizeExempt, @now, @now)
         ON CONFLICT(instance_id, type, arr_id) DO UPDATE SET
           title=excluded.title, show_title=excluded.show_title, season=excluded.season, episode=excluded.episode,
           episode_title=excluded.episode_title, path=excluded.path, size_bytes=excluded.size_bytes, quality=excluded.quality,
           resolution=excluded.resolution, profile=excluded.profile, tags=excluded.tags, poster_remote=excluded.poster_remote,
           poster_bytes=COALESCE(excluded.poster_bytes, poster_bytes),
           arr_series_id=excluded.arr_series_id, arr_episode_file_id=excluded.arr_episode_file_id,
           file_changed_at=CASE WHEN library_items.path != excluded.path OR library_items.size_bytes != excluded.size_bytes THEN excluded.file_changed_at ELSE library_items.file_changed_at END`,
      )
      .run({
        ...item,
        tags: JSON.stringify(item.tags),
        sizeExempt: item.sizeExempt ? 1 : 0,
        posterBytes: item.posterBytes ?? null,
        now,
      });
    if (previous && previous.path !== item.path) {
      this.clearFileError(previous.path);
      this.clearFileErrorsForItem(item.id);
    }
    return item.id;
  }

  getItem(id: string): LibraryItem | undefined {
    const row = this.db.prepare(
      `SELECT i.*, inst.name AS instance_name FROM library_items i JOIN instances inst ON inst.id = i.instance_id WHERE i.id = ?`,
    ).get(id) as Record<string, unknown> | undefined;
    return row ? mapItem(row) : undefined;
  }

  itemsForPath(path: string, instanceId: string): LibraryItem[] {
    if (!path) return [];
    const rows = this.db.prepare(
      `SELECT i.*, inst.name AS instance_name FROM library_items i JOIN instances inst ON inst.id = i.instance_id
       WHERE i.path = ? AND i.instance_id = ?
       ORDER BY i.season, i.episode, i.id`,
    ).all(path, instanceId) as Record<string, unknown>[];
    return rows.map(mapItem);
  }

  fileDisplayTitle(itemId: string): string | undefined {
    const item = this.getItem(itemId);
    if (!item) return undefined;
    return displayTitleForFile(this.itemsForPath(item.path, item.instanceId));
  }

  removeItemsNotIn(instanceId: string, type: "movie" | "episode", keepIds: string[]): void {
    const keep = new Set(keepIds);
    for (const item of this.listItems(type).filter((row) => row.instanceId === instanceId)) {
      if (keep.has(item.id)) continue;
      this.deleteLibraryItem(item.id);
    }
  }

  deleteLibraryItem(id: string): void {
    const item = this.getItem(id);
    this.db.prepare("DELETE FROM inspections WHERE item_id = ?").run(id);
    this.db.prepare("DELETE FROM suggestions WHERE item_id = ?").run(id);
    this.clearFileErrorsForItem(id);
    if (item?.path) this.clearFileError(item.path);
    this.db.prepare("DELETE FROM library_items WHERE id = ?").run(id);
  }

  listItems(type?: "movie" | "episode"): LibraryItem[] {
    const sql = type
      ? `SELECT i.*, inst.name AS instance_name FROM library_items i JOIN instances inst ON inst.id = i.instance_id WHERE i.type = ?`
      : `SELECT i.*, inst.name AS instance_name FROM library_items i JOIN instances inst ON inst.id = i.instance_id`;
    const rows = type ? this.db.prepare(sql).all(type) : this.db.prepare(sql).all();
    return (rows as Record<string, unknown>[]).map(mapItem);
  }

  libraryPage(opts: {
    type: "movie" | "episode";
    offset: number;
    limit: number;
    sort?: "title" | "size" | "quality";
    instanceId?: string;
    arrSeriesId?: number;
  }): { rows: LibrarySnapshot[]; total: number } {
    const where = ["i.type = @type"];
    if (opts.instanceId !== undefined) where.push("i.instance_id = @instanceId");
    if (opts.arrSeriesId !== undefined) where.push("i.arr_series_id = @arrSeriesId");
    const params = {
      type: opts.type,
      offset: opts.offset,
      limit: opts.limit,
      instanceId: opts.instanceId ?? "",
      arrSeriesId: opts.arrSeriesId ?? -1,
    };
    const clause = where.join(" AND ");
    const movieOrder = opts.sort === "size"
      ? "i.size_bytes DESC, LOWER(i.title), i.id"
      : opts.sort === "quality"
        ? "LOWER(i.quality), LOWER(i.title), i.id"
        : "LOWER(i.title), i.id";
    const order = opts.type === "movie" ? movieOrder : "i.season, i.episode, i.id";
    const rows = this.db.prepare(
      `SELECT i.*, inst.name AS instance_name, ins.report AS inspection_report,
              sug.payload AS suggestion_payload,
              (SELECT err.reason FROM file_errors err WHERE err.path = i.path LIMIT 1) AS error_reason
       FROM library_items i
       JOIN instances inst ON inst.id = i.instance_id
       LEFT JOIN inspections ins ON ins.item_id = i.id
       LEFT JOIN suggestions sug ON sug.item_id = i.id AND sug.dismissed = 0
       WHERE ${clause}
       ORDER BY ${order}
       LIMIT @limit OFFSET @offset`,
    ).all(params) as Record<string, unknown>[];
    const total = Number(
      (this.db.prepare(`SELECT COUNT(*) AS n FROM library_items i WHERE ${clause}`).get(params) as { n: number }).n,
    );
    return { rows: rows.map(mapLibrarySnapshot), total };
  }

  movieHealth(): { total: number; healthyCount: number; suggestionCount: number } {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN EXISTS (SELECT 1 FROM inspections ins WHERE ins.item_id = i.id)
                    AND NOT EXISTS (SELECT 1 FROM suggestions s WHERE s.item_id = i.id AND s.dismissed = 0)
                    AND NOT EXISTS (SELECT 1 FROM file_errors err WHERE err.path = i.path)
                  THEN 1 ELSE 0 END) AS healthy_count,
              SUM(CASE WHEN EXISTS (SELECT 1 FROM suggestions s WHERE s.item_id = i.id AND s.dismissed = 0)
                  THEN 1 ELSE 0 END) AS suggestion_count
       FROM library_items i WHERE i.type = 'movie'`,
    ).get() as { total: number; healthy_count: number | null; suggestion_count: number | null };
    return {
      total: Number(row.total),
      healthyCount: Number(row.healthy_count ?? 0),
      suggestionCount: Number(row.suggestion_count ?? 0),
    };
  }

  seriesHealth(instanceId: string, arrSeriesId: number): { episodeCount: number; healthyCount: number; suggestionCount: number } {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS episode_count,
              SUM(CASE WHEN EXISTS (SELECT 1 FROM suggestions s WHERE s.item_id = i.id AND s.dismissed = 0)
                  THEN 1 ELSE 0 END) AS suggestion_count,
              SUM(CASE WHEN EXISTS (SELECT 1 FROM inspections ins WHERE ins.item_id = i.id)
                    AND NOT EXISTS (SELECT 1 FROM suggestions s WHERE s.item_id = i.id AND s.dismissed = 0)
                    AND NOT EXISTS (SELECT 1 FROM file_errors err WHERE err.path = i.path)
                  THEN 1 ELSE 0 END) AS healthy_count
       FROM library_items i
       WHERE i.type = 'episode' AND i.instance_id = ? AND i.arr_series_id = ?`,
    ).get(instanceId, arrSeriesId) as {
      episode_count: number;
      suggestion_count: number | null;
      healthy_count: number | null;
    };
    return {
      episodeCount: Number(row.episode_count),
      healthyCount: Number(row.healthy_count ?? 0),
      suggestionCount: Number(row.suggestion_count ?? 0),
    };
  }

  librarySnapshot(id: string): LibrarySnapshot | undefined {
    const row = this.db.prepare(
      `SELECT i.*, inst.name AS instance_name, ins.report AS inspection_report,
              sug.payload AS suggestion_payload,
              (SELECT err.reason FROM file_errors err WHERE err.path = i.path LIMIT 1) AS error_reason
       FROM library_items i
       JOIN instances inst ON inst.id = i.instance_id
       LEFT JOIN inspections ins ON ins.item_id = i.id
       LEFT JOIN suggestions sug ON sug.item_id = i.id AND sug.dismissed = 0
       WHERE i.id = ?`,
    ).get(id) as Record<string, unknown> | undefined;
    return row ? mapLibrarySnapshot(row) : undefined;
  }

  seriesPage(offset: number, limit: number): { rows: SeriesSummaryRecord[]; total: number } {
    const rows = this.db.prepare(
      `SELECT i.instance_id, inst.name AS instance_name, i.arr_series_id, i.show_title,
              COUNT(*) AS episode_count,
              SUM(CASE WHEN EXISTS (
                    SELECT 1 FROM suggestions s WHERE s.item_id = i.id AND s.dismissed = 0
                  ) THEN 1 ELSE 0 END) AS suggestion_count,
              SUM(CASE WHEN EXISTS (SELECT 1 FROM inspections ins WHERE ins.item_id = i.id)
                    AND NOT EXISTS (SELECT 1 FROM suggestions s WHERE s.item_id = i.id AND s.dismissed = 0)
                    AND NOT EXISTS (SELECT 1 FROM file_errors err WHERE err.path = i.path)
                  THEN 1 ELSE 0 END) AS healthy_count,
              svt.video_target AS video_target,
              svt.audio_mix AS audio_mix
       FROM library_items i
       JOIN instances inst ON inst.id = i.instance_id
       LEFT JOIN series_preferences svt ON svt.instance_id = i.instance_id AND svt.arr_series_id = i.arr_series_id
       WHERE i.type = 'episode' AND i.arr_series_id IS NOT NULL
       GROUP BY i.instance_id, inst.name, i.arr_series_id, i.show_title, svt.video_target, svt.audio_mix
       ORDER BY LOWER(i.show_title), i.instance_id, i.arr_series_id
       LIMIT ? OFFSET ?`,
    ).all(limit, offset) as Record<string, unknown>[];
    const total = Number((this.db.prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT 1 FROM library_items
         WHERE type = 'episode' AND arr_series_id IS NOT NULL
         GROUP BY instance_id, arr_series_id, show_title
       )`,
    ).get() as { n: number }).n);
    return {
      rows: rows.map((row) => ({
        instanceId: String(row.instance_id),
        instanceName: String(row.instance_name),
        arrSeriesId: Number(row.arr_series_id),
        showTitle: String(row.show_title ?? "Untitled series"),
        episodeCount: Number(row.episode_count),
        healthyCount: Number(row.healthy_count),
        suggestionCount: Number(row.suggestion_count),
        videoTarget: parseVideoTarget(row.video_target),
        audioMix: parseAudioMix(row.audio_mix),
      })),
      total,
    };
  }

  setExempt(id: string, exempt: boolean): void {
    this.db.prepare("UPDATE library_items SET size_exempt = ? WHERE id = ?").run(exempt ? 1 : 0, id);
  }

  setItemVideoTarget(id: string, target: VideoTarget | null): void {
    this.db.prepare("UPDATE library_items SET video_target = ? WHERE id = ?").run(target, id);
  }

  getSeriesPreference(instanceId: string, arrSeriesId: number): { videoTarget: VideoTarget | null; audioMix: AudioMix | null } {
    const row = this.db.prepare(
      "SELECT video_target, audio_mix FROM series_preferences WHERE instance_id = ? AND arr_series_id = ?",
    ).get(instanceId, arrSeriesId) as { video_target: string | null; audio_mix: string | null } | undefined;
    return {
      videoTarget: parseVideoTarget(row?.video_target),
      audioMix: parseAudioMix(row?.audio_mix),
    };
  }

  getSeriesVideoTarget(instanceId: string, arrSeriesId: number): VideoTarget | null {
    return this.getSeriesPreference(instanceId, arrSeriesId).videoTarget;
  }

  setSeriesVideoTarget(instanceId: string, arrSeriesId: number, target: VideoTarget | null): void {
    this.upsertSeriesPreference(instanceId, arrSeriesId, { videoTarget: target });
  }

  getSeriesAudioMix(instanceId: string, arrSeriesId: number): AudioMix | null {
    return this.getSeriesPreference(instanceId, arrSeriesId).audioMix;
  }

  setSeriesAudioMix(instanceId: string, arrSeriesId: number, mix: AudioMix | null): void {
    this.upsertSeriesPreference(instanceId, arrSeriesId, { audioMix: mix });
  }

  videoTargetForItem(item: LibraryItem): VideoTarget | null {
    if (item.type === "movie") return parseVideoTarget(item.videoTarget);
    if (item.type === "episode" && item.arrSeriesId != null) {
      return this.getSeriesVideoTarget(item.instanceId, item.arrSeriesId);
    }
    return null;
  }

  audioMixForItem(item: LibraryItem): AudioMix | null {
    if (item.type === "episode" && item.arrSeriesId != null) {
      return this.getSeriesAudioMix(item.instanceId, item.arrSeriesId);
    }
    return null;
  }

  private upsertSeriesPreference(
    instanceId: string,
    arrSeriesId: number,
    patch: { videoTarget?: VideoTarget | null; audioMix?: AudioMix | null },
  ): void {
    const current = this.getSeriesPreference(instanceId, arrSeriesId);
    const videoTarget = patch.videoTarget !== undefined ? patch.videoTarget : current.videoTarget;
    const audioMix = patch.audioMix !== undefined ? patch.audioMix : current.audioMix;
    if (!videoTarget && !audioMix) {
      this.db.prepare("DELETE FROM series_preferences WHERE instance_id = ? AND arr_series_id = ?").run(instanceId, arrSeriesId);
      return;
    }
    this.db.prepare(
      `INSERT INTO series_preferences (instance_id, arr_series_id, video_target, audio_mix) VALUES (?, ?, ?, ?)
       ON CONFLICT(instance_id, arr_series_id) DO UPDATE SET video_target = excluded.video_target, audio_mix = excluded.audio_mix`,
    ).run(instanceId, arrSeriesId, videoTarget, audioMix);
  }

  updateItemFile(id: string, path: string, sizeBytes: number): void {
    this.db.prepare("UPDATE library_items SET path = ?, size_bytes = ? WHERE id = ?").run(path, sizeBytes, id);
  }

  markKeptSize(id: string, sizeBytes: number): void {
    this.db.prepare("UPDATE library_items SET kept_size_bytes = ? WHERE id = ?").run(sizeBytes, id);
  }

  deleteInspection(itemId: string): void {
    this.db.prepare("DELETE FROM inspections WHERE item_id = ?").run(itemId);
  }

  saveInspection(itemId: string, report: InspectionReport): void {
    this.db
      .prepare("INSERT OR REPLACE INTO inspections (item_id, source_sig, report) VALUES (?, ?, ?)")
      .run(itemId, report.sourceSig, JSON.stringify(report));
  }

  getInspection(itemId: string): InspectionReport | undefined {
    const row = this.db.prepare("SELECT report FROM inspections WHERE item_id = ?").get(itemId) as { report: string } | undefined;
    return row ? normalizeInspection(JSON.parse(row.report) as Record<string, unknown>) : undefined;
  }

  getInspectionSig(itemId: string): string | undefined {
    const row = this.db.prepare("SELECT source_sig FROM inspections WHERE item_id = ?").get(itemId) as { source_sig: string } | undefined;
    return row?.source_sig;
  }

  saveSuggestion(itemId: string, suggestion: Suggestion | null): Suggestion | undefined {
    this.db.prepare("DELETE FROM suggestions WHERE item_id = ? AND dismissed = 0").run(itemId);
    if (!suggestion) return undefined;
    const id = suggestion.id || randomUUID();
    const stored = { ...suggestion, id, itemId };
    this.db.prepare("INSERT INTO suggestions (id, item_id, payload, dismissed) VALUES (?, ?, ?, 0)").run(id, itemId, JSON.stringify(stored));
    return stored;
  }

  dismissSuggestion(id: string): void {
    this.db.prepare("UPDATE suggestions SET dismissed = 1 WHERE id = ?").run(id);
  }

  getSuggestion(id: string): Suggestion | undefined {
    const row = this.db.prepare("SELECT payload, dismissed FROM suggestions WHERE id = ?").get(id) as
      | { payload: string; dismissed: number }
      | undefined;
    if (!row) return undefined;
    return { ...(JSON.parse(row.payload) as Suggestion), dismissed: row.dismissed === 1 };
  }

  openSuggestionForItem(itemId: string): Suggestion | undefined {
    const row = this.db.prepare("SELECT payload FROM suggestions WHERE item_id = ? AND dismissed = 0").get(itemId) as
      | { payload: string }
      | undefined;
    return row ? (JSON.parse(row.payload) as Suggestion) : undefined;
  }

  listSuggestions(): Suggestion[] {
    return (this.db.prepare("SELECT payload FROM suggestions WHERE dismissed = 0").all() as { payload: string }[]).map(
      (r) => JSON.parse(r.payload) as Suggestion,
    );
  }

  suggestionPage(offset: number, limit: number, query = "", filters: SuggestionFilters = {}): Page<Suggestion & { displayTitle: string; instanceName?: string; type?: LibraryItem["type"]; quality?: string; hasPoster: boolean }> {
    const filtered = suggestionWhere(query, filters, this.getSettings());
    const joins = "FROM suggestions s LEFT JOIN library_items i ON i.id = s.item_id LEFT JOIN instances n ON n.id = i.instance_id LEFT JOIN inspections ins ON ins.item_id = i.id";
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS n ${joins} WHERE ${filtered.where}`).get(...filtered.params) as { n: number }).n);
    const rows = this.db.prepare(
      `SELECT s.payload, i.type AS item_type, i.title AS item_title, i.show_title AS item_show_title,
              i.season AS item_season, i.episode AS item_episode, i.episode_title AS item_episode_title,
              i.quality AS item_quality, i.poster_bytes AS item_poster_bytes, i.poster_remote AS item_poster_remote,
              n.name AS item_instance_name, ins.report AS inspection_report
       ${joins}
       WHERE ${filtered.where}
       ORDER BY LOWER(COALESCE(i.show_title, i.title, s.item_id)), i.season, i.episode, s.id
       LIMIT ? OFFSET ?`,
    ).all(...filtered.params, limit, offset) as Record<string, unknown>[];
    return page(rows.map((row) => {
      const suggestion = JSON.parse(String(row.payload)) as Suggestion;
      const report = row.inspection_report == null
        ? null
        : normalizeInspection(JSON.parse(String(row.inspection_report)) as Record<string, unknown>);
      const tracks = suggestionTrackComparison(report, suggestion);
      return {
        ...suggestion,
        now: { ...suggestion.now, tracks: tracks.nowTracks },
        after: { ...suggestion.after, tracks: tracks.afterTracks },
        displayTitle: joinedDisplayTitle(row, suggestion.itemId),
        instanceName: row.item_instance_name == null ? undefined : String(row.item_instance_name),
        type: row.item_type === "episode" ? "episode" : row.item_type === "movie" ? "movie" : undefined,
        href: itemHref(row.item_type, suggestion.itemId),
        quality: row.item_quality == null ? undefined : String(row.item_quality),
        hasPoster: Boolean(row.item_poster_bytes || row.item_poster_remote),
      };
    }), total, offset, limit);
  }

  suggestionIds(query = "", filters: SuggestionFilters = {}): string[] {
    const filtered = suggestionWhere(query, filters, this.getSettings());
    const rows = this.db.prepare(
      `SELECT s.id FROM suggestions s
       LEFT JOIN library_items i ON i.id = s.item_id
       LEFT JOIN instances n ON n.id = i.instance_id
       LEFT JOIN inspections ins ON ins.item_id = i.id
       WHERE ${filtered.where}
       ORDER BY s.id`,
    ).all(...filtered.params) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  setFileError(path: string, itemId: string | null, reason: string): void {
    this.db.prepare("INSERT OR REPLACE INTO file_errors (path, item_id, reason) VALUES (?, ?, ?)").run(path, itemId, reason);
  }

  clearFileError(path: string): void {
    this.db.prepare("DELETE FROM file_errors WHERE path = ?").run(path);
  }

  clearFileErrorsForItem(itemId: string): void {
    this.db.prepare("DELETE FROM file_errors WHERE item_id = ?").run(itemId);
  }

  listErrors(): FileError[] {
    const rows = this.db.prepare(
      `SELECT path, item_id, reason FROM file_errors e WHERE ${currentFileErrorSql("e")}`,
    ).all() as Array<{
      path: string;
      item_id: string | null;
      reason: string;
    }>;
    return rows.map((r) => {
      const item = r.item_id ? this.getItem(r.item_id) : undefined;
      const fileName = r.path.split("/").pop() || r.path;
      return {
        itemId: r.item_id,
        path: r.path,
        fileName,
        displayTitle: item ? `${item.title}` : fileName,
        reason: r.reason,
        type: item?.type,
        href: item ? itemHref(item.type, item.id) : undefined,
      };
    });
  }

  errorPage(offset: number, limit: number): Page<FileError> {
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM file_errors e WHERE ${currentFileErrorSql("e")}`).get() as { n: number }).n);
    const rows = this.db.prepare(
      `SELECT e.path, e.item_id, e.reason, i.type AS item_type, i.title AS item_title,
              i.show_title AS item_show_title, i.season AS item_season, i.episode AS item_episode,
              i.episode_title AS item_episode_title
       FROM file_errors e LEFT JOIN library_items i ON i.id = e.item_id
       WHERE ${currentFileErrorSql("e")}
       ORDER BY e.path LIMIT ? OFFSET ?`,
    ).all(limit, offset) as Record<string, unknown>[];
    return page(rows.map((row) => {
      const itemId = row.item_id == null ? null : String(row.item_id);
      const fileName = String(row.path).split("/").pop() || String(row.path);
      const type = row.item_type === "episode" ? "episode" as const : row.item_type === "movie" ? "movie" as const : undefined;
      return {
        itemId,
        path: String(row.path),
        fileName,
        displayTitle: joinedDisplayTitle(row, fileName),
        reason: String(row.reason),
        type,
        href: itemId == null ? undefined : itemHref(row.item_type, itemId),
      };
    }), total, offset, limit);
  }

  setInspectState(state: { walking: boolean; pending: number; inspected: number; failed: number }): void {
    this.db
      .prepare("UPDATE inspect_state SET walking=?, pending=?, inspected=?, failed=? WHERE id=1")
      .run(state.walking ? 1 : 0, state.pending, state.inspected, state.failed);
  }

  getInspectState(): { walking: boolean; pending: number; inspected: number; failed: number } {
    const row = this.db.prepare("SELECT * FROM inspect_state WHERE id=1").get() as {
      walking: number;
      pending: number;
      inspected: number;
      failed: number;
    };
    return { walking: row.walking === 1, pending: row.pending, inspected: row.inspected, failed: row.failed };
  }

  insertJob(job: Omit<Job, "displayTitle" | "writeMode" | "promoteError" | "assignedNodeId" | "nodeId" | "startedAt"> & {
    plan: unknown;
    position?: number;
    writeMode?: "sidecar" | "direct";
    promoteError?: string | null;
    assignedNodeId?: string | null;
  }): string {
    const position =
      job.position ??
      ((this.db.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS n FROM jobs").get() as { n: number }).n);
    this.db
      .prepare(
        `INSERT INTO jobs (id, item_id, suggestion_id, status, phase, progress, error, warning, run_now, position, plan, created_at, write_mode, promote_error, assigned_node_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        job.id,
        job.itemId,
        job.suggestionId,
        job.status,
        job.phase,
        job.progress,
        job.error,
        job.warning,
        job.runNow ? 1 : 0,
        position,
        JSON.stringify(job.plan),
        job.createdAt,
        job.writeMode === "direct" ? "direct" : "sidecar",
        job.promoteError ?? null,
        job.assignedNodeId ?? null,
      );
    return job.id;
  }

  updateJob(id: string, patch: Partial<{
    status: JobStatus;
    phase: JobPhase;
    progress: number;
    error: string | null;
    runNow: boolean;
    position: number;
    promoteError: string | null;
    writeMode: "sidecar" | "direct";
    nodeId: string | null;
    startedAt: number | null;
  }>): void {
    const current = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!current) return;
    this.db
      .prepare(
        "UPDATE jobs SET status=?, phase=?, progress=?, error=?, run_now=?, position=?, write_mode=?, promote_error=?, node_id=?, started_at=? WHERE id=?",
      )
      .run(
        patch.status ?? current.status,
        patch.phase ?? current.phase,
        patch.progress ?? current.progress,
        patch.error === undefined ? current.error : patch.error,
        (patch.runNow ?? current.run_now === 1) ? 1 : 0,
        patch.position ?? current.position,
        patch.writeMode ?? current.write_mode ?? "sidecar",
        patch.promoteError === undefined ? current.promote_error : patch.promoteError,
        patch.nodeId === undefined ? current.node_id : patch.nodeId,
        patch.startedAt === undefined ? current.started_at : patch.startedAt,
        id,
      );
  }

  appendJobLog(id: string, chunk: string): void {
    const row = this.db.prepare("SELECT log FROM jobs WHERE id = ?").get(id) as { log: string | null } | undefined;
    if (!row) return;
    const next = `${row.log ?? ""}${chunk}`.slice(-32_768);
    this.db.prepare("UPDATE jobs SET log = ? WHERE id = ?").run(next, id);
  }

  jobLog(id: string): string | null {
    const row = this.db.prepare("SELECT log FROM jobs WHERE id = ?").get(id) as { log: string | null } | undefined;
    return row ? (row.log ?? "") : null;
  }

  listJobs(): Array<Job & { plan: JobPlan }> {
    return (this.db.prepare("SELECT * FROM jobs WHERE queue_visible = 1 ORDER BY position ASC").all() as Record<string, unknown>[]).map(mapJob);
  }

  jobPage(offset: number, limit: number): Page<Job & { plan: JobPlan }> {
    const total = Number((this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE queue_visible = 1").get() as { n: number }).n);
    const finishedCount = Number((this.db.prepare(
      "SELECT COUNT(*) AS n FROM jobs WHERE queue_visible = 1 AND status IN ('succeeded','failed','cancelled')",
    ).get() as { n: number }).n);
    const rows = this.db.prepare(
      `SELECT j.*, i.type AS item_type, i.title AS item_title, i.show_title AS item_show_title,
              i.season AS item_season, i.episode AS item_episode, i.episode_title AS item_episode_title
       FROM jobs j LEFT JOIN library_items i ON i.id = j.item_id
       WHERE j.queue_visible = 1
       ORDER BY CASE j.status
         WHEN 'running' THEN 0
         WHEN 'queued' THEN 1
         WHEN 'held' THEN 1
         WHEN 'paused' THEN 1
         ELSE 2
       END ASC, j.position ASC
       LIMIT ? OFFSET ?`,
    ).all(limit, offset) as Record<string, unknown>[];
    return {
      ...page(rows.map((row) => {
        const itemId = String(row.item_id);
        return {
          ...mapJob(row),
          displayTitle: this.fileDisplayTitle(itemId) ?? joinedDisplayTitle(row, itemId),
          href: row.item_type == null ? undefined : itemHref(row.item_type, itemId),
        };
      }), total, offset, limit),
      finishedCount,
    };
  }

  getJob(id: string): (Job & { plan: JobPlan }) | undefined {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapJob(row) : undefined;
  }

  activeJobForItem(itemId: string): (Job & { plan: JobPlan }) | undefined {
    const row = this.db
      .prepare("SELECT * FROM jobs WHERE item_id = ? AND status IN ('queued','held','paused','running')")
      .get(itemId) as Record<string, unknown> | undefined;
    return row ? mapJob(row) : undefined;
  }

  activeJobForPath(path: string, instanceId: string): (Job & { plan: JobPlan }) | undefined {
    if (!path) return undefined;
    const row = this.db.prepare(
      `SELECT j.* FROM jobs j JOIN library_items i ON i.id = j.item_id
       WHERE i.path = ? AND i.instance_id = ? AND j.status IN ('queued','held','paused','running')`,
    ).get(path, instanceId) as Record<string, unknown> | undefined;
    return row ? mapJob(row) : undefined;
  }

  cancelActiveJobs(now = Date.now()): string[] {
    const cancel = this.db.transaction(() => {
      const rows = this.db.prepare(
        "SELECT id, item_id FROM jobs WHERE status IN ('queued','held','paused','running') ORDER BY position",
      ).all() as Array<{ id: string; item_id: string }>;
      this.db.prepare(
        "UPDATE jobs SET status = 'cancelled', phase = 'idle', error = 'Cancelled.' WHERE status IN ('queued','held','paused','running')",
      ).run();
      const history = this.db.prepare(
        "INSERT INTO history (id, item_id, outcome, bytes_saved, created_at) VALUES (?, ?, 'cancelled', 0, ?)",
      );
      for (const row of rows) history.run(randomUUID(), row.item_id, now);
      return rows.map((row) => row.id);
    });
    return cancel();
  }

  recoverInterruptedJobs(now = Date.now(), localNodeId = ""): number {
    const expired = this.expireLeases(now);
    const local = this.db.prepare(
      `UPDATE jobs SET status = 'queued', phase = 'queued', progress = 0,
         error = 'Recovered after Polisharr restarted.', node_id = NULL, lease_until = NULL, lease_token = NULL
       WHERE status = 'running' AND (lease_token IS NULL OR node_id = ?)`,
    ).run(localNodeId).changes;
    return expired + local;
  }

  expireLeases(now: number): number {
    return this.db.prepare(
      `UPDATE jobs SET status = 'queued', phase = 'queued', progress = 0,
         error = 'The encode node stopped. The job is waiting on that node again.',
         node_id = NULL, lease_until = NULL, lease_token = NULL
       WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until < ?`,
    ).run(now).changes;
  }

  claimQueuedJobs(nodeId: string, limit: number, now: number, leaseMs: number): Array<(Job & { plan: JobPlan; leaseToken: string })> {
    const node = this.getNode(nodeId);
    if (!node?.enabled) return [];
    const slots = Math.max(0, node.concurrency - this.runningCountOnNode(nodeId));
    limit = Math.min(limit, slots);
    if (limit <= 0) return [];
    const claim = this.db.transaction(() => {
      const rows = this.db.prepare(
        "SELECT id FROM jobs WHERE status = 'queued' AND assigned_node_id = ? ORDER BY position ASC LIMIT ?",
      ).all(nodeId, limit) as Array<{ id: string }>;
      const claimed: Array<(Job & { plan: JobPlan; leaseToken: string })> = [];
      const take = this.db.prepare(
        `UPDATE jobs SET status = 'running', phase = 'muxing', progress = 0.05, error = NULL,
           node_id = ?, lease_until = ?, lease_token = ?, started_at = COALESCE(started_at, ?)
         WHERE id = ? AND status = 'queued' AND assigned_node_id = ?`,
      );
      for (const row of rows) {
        const token = randomUUID();
        const result = take.run(nodeId, now + leaseMs, token, now, row.id, nodeId);
        if (result.changes !== 1) continue;
        const job = this.getJob(row.id);
        if (job) claimed.push({ ...job, leaseToken: token });
      }
      return claimed;
    });
    return claim();
  }

  jobLease(id: string): { token: string | null; until: number | null; nodeId: string | null } | undefined {
    const row = this.db.prepare("SELECT lease_token, lease_until, node_id FROM jobs WHERE id = ?").get(id) as
      | { lease_token: string | null; lease_until: number | null; node_id: string | null }
      | undefined;
    if (!row) return undefined;
    return { token: row.lease_token, until: row.lease_until, nodeId: row.node_id };
  }

  leaseMatches(id: string, token: string): boolean {
    const lease = this.jobLease(id);
    return Boolean(lease?.token && token && lease.token === token);
  }

  renewNodeLeases(nodeId: string, jobIds: string[], until: number): void {
    if (jobIds.length === 0) return;
    const stmt = this.db.prepare(
      "UPDATE jobs SET lease_until = ? WHERE id = ? AND node_id = ? AND status = 'running'",
    );
    const tx = this.db.transaction(() => {
      for (const id of jobIds) stmt.run(until, id, nodeId);
    });
    tx();
  }

  cancelledIdsForNode(nodeId: string): string[] {
    return (this.db.prepare(
      "SELECT id FROM jobs WHERE node_id = ? AND status = 'cancelled'",
    ).all(nodeId) as Array<{ id: string }>).map((row) => row.id);
  }

  runningCountOnNode(nodeId: string): number {
    return Number((this.db.prepare(
      "SELECT COUNT(*) AS n FROM jobs WHERE node_id = ? AND status = 'running'",
    ).get(nodeId) as { n: number }).n);
  }

  setJobAssignedNode(id: string, nodeId: string): void {
    this.db.prepare("UPDATE jobs SET assigned_node_id = ? WHERE id = ?").run(nodeId, id);
  }

  removeFinishedJob(id: string): "removed" | "active" | "missing" {
    const row = this.db.prepare("SELECT status FROM jobs WHERE id = ?").get(id) as { status: JobStatus } | undefined;
    if (!row) return "missing";
    if (row.status === "queued" || row.status === "held" || row.status === "paused" || row.status === "running") {
      return "active";
    }
    this.db.prepare("UPDATE jobs SET queue_visible = 0 WHERE id = ?").run(id);
    return "removed";
  }

  clearFinishedJobs(): number {
    return this.db.prepare(
      "UPDATE jobs SET queue_visible = 0 WHERE queue_visible = 1 AND status IN ('succeeded','failed','cancelled')",
    ).run().changes;
  }

  insertReview(row: ReviewItem): void {
    this.db
      .prepare(
        `INSERT INTO reviews (id, job_id, item_id, status, flagged, flag_reason, source_path, sidecar_path, compare, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.jobId,
        row.itemId,
        row.status,
        row.flagged ? 1 : 0,
        row.flagReason,
        row.sourcePath,
        row.sidecarPath,
        JSON.stringify({
          source: row.source,
          sidecar: row.sidecar,
          nodeName: row.nodeName ?? null,
          encodeApi: row.encodeApi ?? null,
          gpuName: row.gpuName ?? null,
          encodeMs: row.encodeMs ?? null,
        }),
        row.error,
      );
  }

  listReviews(): ReviewItem[] {
    return (this.db.prepare("SELECT * FROM reviews").all() as Record<string, unknown>[]).map(mapReview);
  }

  reviewPage(offset: number, limit: number): Page<ReviewItem> {
    const total = Number((this.db.prepare("SELECT COUNT(*) AS n FROM reviews").get() as { n: number }).n);
    const rows = this.db.prepare(
      `SELECT r.*, i.type AS item_type, i.title AS item_title, i.show_title AS item_show_title,
              i.season AS item_season, i.episode AS item_episode, i.episode_title AS item_episode_title
       FROM reviews r LEFT JOIN library_items i ON i.id = r.item_id
       ORDER BY r.id LIMIT ? OFFSET ?`,
    ).all(limit, offset) as Record<string, unknown>[];
    return {
      ...page(rows.map((row) => ({ ...mapReview(row), displayTitle: this.fileDisplayTitle(String(row.item_id)) ?? joinedDisplayTitle(row, String(row.item_id)) })), total, offset, limit),
      pendingCount: this.pendingReviewCount(),
    };
  }

  pendingReviewIds(): string[] {
    return (this.db.prepare("SELECT id FROM reviews WHERE status = 'pending'").all() as Array<{ id: string }>).map((row) => row.id);
  }

  pendingReviewCount(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM reviews WHERE status = 'pending'").get() as { n: number }).n);
  }

  getReview(id: string): ReviewItem | undefined {
    const row = this.db.prepare("SELECT * FROM reviews WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapReview(row) : undefined;
  }

  pendingReviewForItem(itemId: string): ReviewItem | undefined {
    const row = this.db.prepare("SELECT * FROM reviews WHERE item_id = ?").get(itemId) as Record<string, unknown> | undefined;
    return row ? mapReview(row) : undefined;
  }

  pendingReviewForPath(path: string, instanceId: string): ReviewItem | undefined {
    if (!path) return undefined;
    const row = this.db.prepare(
      `SELECT r.* FROM reviews r JOIN library_items i ON i.id = r.item_id
       WHERE i.path = ? AND i.instance_id = ?`,
    ).get(path, instanceId) as Record<string, unknown> | undefined;
    return row ? mapReview(row) : undefined;
  }

  reviewsForSidecarPath(sidecarPath: string): ReviewItem[] {
    if (!sidecarPath) return [];
    return (this.db.prepare("SELECT * FROM reviews WHERE sidecar_path = ?").all(sidecarPath) as Record<string, unknown>[]).map(mapReview);
  }

  updateReview(id: string, patch: Partial<{ status: ReviewStatus; error: string | null }>): void {
    const current = this.getReview(id);
    if (!current) return;
    this.db
      .prepare("UPDATE reviews SET status=?, error=? WHERE id=?")
      .run(patch.status ?? current.status, patch.error === undefined ? current.error : patch.error, id);
  }

  deleteReview(id: string): void {
    this.db.prepare("DELETE FROM reviews WHERE id = ?").run(id);
  }

  addHistory(itemId: string, outcome: ActivityOutcome, bytesSaved: number, now = Date.now()): void {
    this.db
      .prepare("INSERT INTO history (id, item_id, outcome, bytes_saved, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(randomUUID(), itemId, outcome, bytesSaved, now);
  }

  listHistory(): HistoryRow[] {
    return (this.db.prepare("SELECT * FROM history ORDER BY created_at DESC").all() as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      itemId: String(r.item_id),
      displayTitle: this.getItem(String(r.item_id))?.title ?? String(r.item_id),
      outcome: activityOutcome(r.outcome),
      bytesSaved: Number(r.bytes_saved),
      createdAt: Number(r.created_at),
    }));
  }

  historyPage(offset: number, limit: number): Page<HistoryRow> {
    const total = Number((this.db.prepare("SELECT COUNT(*) AS n FROM history").get() as { n: number }).n);
    const rows = this.db.prepare(
      `SELECT h.*, i.type AS item_type, i.title AS item_title, i.show_title AS item_show_title,
              i.season AS item_season, i.episode AS item_episode, i.episode_title AS item_episode_title
       FROM history h LEFT JOIN library_items i ON i.id = h.item_id
       ORDER BY h.created_at DESC, h.id LIMIT ? OFFSET ?`,
    ).all(limit, offset) as Record<string, unknown>[];
    return page(rows.map((row) => ({
      id: String(row.id),
      itemId: String(row.item_id),
      displayTitle: joinedDisplayTitle(row, String(row.item_id)),
      outcome: activityOutcome(row.outcome),
      bytesSaved: Number(row.bytes_saved),
      createdAt: Number(row.created_at),
    })), total, offset, limit);
  }

  workSummary(): {
    suggestions: number;
    queued: number;
    queueActive: number;
    review: number;
    errors: number;
    failed: number;
    running: (Job & { plan: JobPlan }) | null;
  } {
    const counts = this.db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM suggestions WHERE dismissed = 0) AS suggestions,
         (SELECT COUNT(*) FROM jobs WHERE queue_visible = 1 AND status IN ('queued', 'held')) AS queued,
         (SELECT COUNT(*) FROM jobs WHERE queue_visible = 1 AND status IN ('queued', 'held', 'paused', 'running')) AS queue_active,
         (SELECT COUNT(*) FROM reviews) AS review,
         (SELECT COUNT(*) FROM file_errors e WHERE ${currentFileErrorSql("e")}) AS errors,
         (SELECT COUNT(*) FROM jobs WHERE queue_visible = 1 AND status = 'failed') AS failed`,
    ).get() as Record<string, number>;
    const row = this.db.prepare(
      `SELECT j.*, i.type AS item_type, i.title AS item_title, i.show_title AS item_show_title,
              i.season AS item_season, i.episode AS item_episode, i.episode_title AS item_episode_title
       FROM jobs j LEFT JOIN library_items i ON i.id = j.item_id
       WHERE j.queue_visible = 1 AND j.status = 'running' ORDER BY j.position LIMIT 1`,
    ).get() as Record<string, unknown> | undefined;
    return {
      suggestions: Number(counts.suggestions),
      queued: Number(counts.queued),
      queueActive: Number(counts.queue_active),
      review: Number(counts.review),
      errors: Number(counts.errors),
      failed: Number(counts.failed),
      running: row ? { ...mapJob(row), displayTitle: this.fileDisplayTitle(String(row.item_id)) ?? joinedDisplayTitle(row, String(row.item_id)) } : null,
    };
  }

  savings(): { filesOptimized: number; spaceSavedBytes: number } {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(bytes_saved), 0) AS b FROM history WHERE outcome = 'kept'")
      .get() as { n: number; b: number };
    return { filesOptimized: row.n, spaceSavedBytes: row.b };
  }

  addExclusion(kind: ExclusionKind, value: string): string {
    const id = randomUUID();
    this.db.prepare("INSERT INTO exclusions (id, kind, value) VALUES (?, ?, ?)").run(id, kind, value);
    return id;
  }

  listExclusions(): Array<{ id: string; kind: ExclusionKind; value: string }> {
    return this.db.prepare("SELECT * FROM exclusions").all() as Array<{ id: string; kind: ExclusionKind; value: string }>;
  }

  deleteExclusion(id: string): void {
    this.db.prepare("DELETE FROM exclusions WHERE id = ?").run(id);
  }

  widgetKeyHash(): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'widget'").get() as { value: string } | undefined;
    return row?.value ?? null;
  }

  setWidgetKeyHash(hash: string): void {
    this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('widget', ?)").run(hash);
  }

  webhookTokenHash(): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'webhook'").get() as { value: string } | undefined;
    return row?.value ?? null;
  }

  setWebhookTokenHash(hash: string): void {
    this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('webhook', ?)").run(hash);
  }

  clusterTokenHash(): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'cluster'").get() as { value: string } | undefined;
    return row?.value ?? null;
  }

  setClusterTokenHash(hash: string): void {
    this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('cluster', ?)").run(hash);
  }

  localNodeId(): string {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'local_node_id'").get() as { value: string } | undefined;
    if (row?.value) return row.value;
    const id = randomUUID();
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('local_node_id', ?)").run(id);
    return id;
  }

  upsertNode(node: ClusterNode): void {
    this.db.prepare(
      `INSERT INTO nodes (id, name, role, last_seen, hardware, concurrency, enabled, version, current_job_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         role = excluded.role,
         last_seen = excluded.last_seen,
         hardware = excluded.hardware,
         concurrency = excluded.concurrency,
         enabled = excluded.enabled,
         version = excluded.version,
         current_job_id = excluded.current_job_id`,
    ).run(
      node.id,
      node.name,
      node.role,
      node.lastSeen,
      JSON.stringify(node.hardware),
      node.concurrency,
      node.enabled ? 1 : 0,
      node.version,
      node.currentJobId,
    );
  }

  getNode(id: string): ClusterNode | undefined {
    const row = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapNode(row) : undefined;
  }

  listNodes(): ClusterNode[] {
    return (this.db.prepare("SELECT * FROM nodes ORDER BY name ASC").all() as Record<string, unknown>[]).map(mapNode);
  }

  close(): void {
    this.db.close();
  }
}

function mapItem(row: Record<string, unknown>): LibraryItem {
  return {
    id: String(row.id),
    instanceId: String(row.instance_id),
    instanceName: String(row.instance_name ?? ""),
    arrId: Number(row.arr_id),
    arrSeriesId: row.arr_series_id == null ? null : Number(row.arr_series_id),
    arrEpisodeFileId: row.arr_episode_file_id == null ? null : Number(row.arr_episode_file_id),
    type: mediaType(row.type),
    title: String(row.title),
    showTitle: row.show_title == null ? null : String(row.show_title),
    season: row.season == null ? null : Number(row.season),
    episode: row.episode == null ? null : Number(row.episode),
    episodeTitle: row.episode_title == null ? null : String(row.episode_title),
    path: String(row.path),
    sizeBytes: Number(row.size_bytes),
    quality: String(row.quality ?? ""),
    resolution: String(row.resolution ?? ""),
    profile: String(row.profile ?? ""),
    tags: stringList(JSON.parse(String(row.tags ?? "[]"))),
    posterRemoteUrl: row.poster_remote == null ? null : String(row.poster_remote),
    hasPoster: Boolean(row.poster_bytes || row.poster_remote),
    sizeExempt: Number(row.size_exempt) === 1,
    videoTarget: parseVideoTarget(row.video_target),
    firstSeenAt: Number(row.first_seen_at ?? 0),
    fileChangedAt: Number(row.file_changed_at ?? 0),
    keptSizeBytes: Number(row.kept_size_bytes ?? 0),
  };
}

function mapLibrarySnapshot(row: Record<string, unknown>): LibrarySnapshot {
  return {
    item: mapItem(row),
    report: row.inspection_report == null
      ? null
      : normalizeInspection(JSON.parse(String(row.inspection_report)) as Record<string, unknown>),
    suggestion: row.suggestion_payload == null
      ? null
      : (JSON.parse(String(row.suggestion_payload)) as Suggestion),
    error: row.error_reason == null ? null : String(row.error_reason),
  };
}

function mapJob(row: Record<string, unknown>): Job & { plan: JobPlan } {
  return {
    id: String(row.id),
    itemId: String(row.item_id),
    suggestionId: row.suggestion_id == null ? null : String(row.suggestion_id),
    displayTitle: "",
    status: jobStatus(row.status),
    phase: jobPhase(row.phase),
    progress: Number(row.progress),
    error: row.error == null ? null : String(row.error),
    warning: row.warning == null ? null : String(row.warning),
    runNow: Number(row.run_now) === 1,
    createdAt: Number(row.created_at),
    writeMode: row.write_mode === "direct" ? "direct" : "sidecar",
    promoteError: row.promote_error == null ? null : String(row.promote_error),
    assignedNodeId: row.assigned_node_id == null || row.assigned_node_id === "" ? null : String(row.assigned_node_id),
    nodeId: row.node_id == null || row.node_id === "" ? null : String(row.node_id),
    startedAt: row.started_at == null ? null : Number(row.started_at),
    plan: JSON.parse(String(row.plan)) as JobPlan,
  };
}

function mapReview(row: Record<string, unknown>): ReviewItem {
  const compare = JSON.parse(String(row.compare)) as {
    source: ReviewItem["source"];
    sidecar: ReviewItem["sidecar"];
    nodeName?: unknown;
    encodeApi?: unknown;
    gpuName?: unknown;
    encodeMs?: unknown;
  };
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    itemId: String(row.item_id),
    displayTitle: "",
    status: reviewStatus(row.status),
    flagged: Number(row.flagged) === 1,
    flagReason: row.flag_reason == null ? null : String(row.flag_reason),
    sourcePath: String(row.source_path),
    sidecarPath: String(row.sidecar_path),
    source: compare.source,
    sidecar: compare.sidecar,
    error: row.error == null ? null : String(row.error),
    nodeName: typeof compare.nodeName === "string" ? compare.nodeName : null,
    encodeApi: typeof compare.encodeApi === "string" ? compare.encodeApi : null,
    gpuName: typeof compare.gpuName === "string" ? compare.gpuName : null,
    encodeMs: typeof compare.encodeMs === "number" && Number.isFinite(compare.encodeMs) ? compare.encodeMs : null,
  };
}

function mapNode(row: Record<string, unknown>): ClusterNode {
  let hardwareRaw: unknown = {};
  try {
    hardwareRaw = JSON.parse(String(row.hardware ?? "{}"));
  } catch {
    hardwareRaw = {};
  }
  return {
    id: String(row.id),
    name: String(row.name),
    role: parseNodeRole(row.role),
    lastSeen: Number(row.last_seen),
    hardware: parseHardwareInfo(hardwareRaw),
    concurrency: Number(row.concurrency) || 1,
    enabled: Number(row.enabled) === 1,
    version: String(row.version ?? ""),
    currentJobId: row.current_job_id == null ? null : String(row.current_job_id),
  };
}

function mapInstance(row: Record<string, unknown>): StoredInstance {
  const kind = row.kind;
  if (kind !== "radarr" && kind !== "sonarr" && kind !== "plex" && kind !== "jellyfin") {
    throw new Error(`The saved integration kind ${String(kind)} is invalid.`);
  }
  return {
    id: String(row.id),
    kind,
    name: String(row.name),
    url: String(row.url),
    secret: row.secret == null ? null : String(row.secret),
    enabled: Number(row.enabled) === 1,
  };
}

function mediaType(value: unknown): LibraryItem["type"] {
  if (value === "movie" || value === "episode") return value;
  throw new Error(`The saved media type ${String(value)} is invalid.`);
}

function jobStatus(value: unknown): JobStatus {
  if (value === "queued" || value === "held" || value === "paused" || value === "running" || value === "succeeded" || value === "failed" || value === "cancelled") return value;
  throw new Error(`The saved job status ${String(value)} is invalid.`);
}

function jobPhase(value: unknown): JobPhase {
  if (value === "queued" || value === "held" || value === "paused" || value === "copying" || value === "muxing" || value === "creating_stereo" || value === "transcoding" || value === "finishing" || value === "idle") return value;
  throw new Error(`The saved job phase ${String(value)} is invalid.`);
}

function reviewStatus(value: unknown): ReviewStatus {
  if (value === "pending" || value === "keeping" || value === "discarding") return value;
  throw new Error(`The saved review status ${String(value)} is invalid.`);
}

function activityOutcome(value: unknown): ActivityOutcome {
  if (value === "kept" || value === "discarded" || value === "flagged" || value === "failed" || value === "cancelled" || value === "searched") return value;
  throw new Error(`The saved activity outcome ${String(value)} is invalid.`);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function page<T>(items: T[], total: number, offset: number, limit: number): Page<T> {
  const consumed = offset + items.length;
  return { items, total, nextOffset: consumed < total && items.length === limit ? consumed : null };
}

function currentFileErrorSql(alias: string): string {
  return `(${alias}.item_id IS NULL OR EXISTS (SELECT 1 FROM library_items i WHERE i.id = ${alias}.item_id AND i.path = ${alias}.path))`;
}

function itemHref(itemType: unknown, itemId: string): string {
  return itemType === "episode" ? `/series/episodes/${itemId}` : `/movies/${itemId}`;
}

function joinedDisplayTitle(row: Record<string, unknown>, fallback: string): string {
  if (row.item_title == null) return fallback;
  return displayTitle({
    type: row.item_type === "episode" ? "episode" : "movie",
    title: String(row.item_title),
    showTitle: row.item_show_title == null ? null : String(row.item_show_title),
    season: row.item_season == null ? null : Number(row.item_season),
    episode: row.item_episode == null ? null : Number(row.item_episode),
    episodeTitle: row.item_episode_title == null ? null : String(row.item_episode_title),
  });
}

function suggestionWhere(query: string, filters: SuggestionFilters, settings: Settings): { where: string; params: unknown[] } {
  const conditions = ["s.dismissed = 0"];
  const params: unknown[] = [];
  for (const token of tokenize(query)) {
    conditions.push(`LOWER(COALESCE(i.title, '') || ' ' || COALESCE(i.show_title, '') || ' ' || COALESCE(i.episode_title, '') || ' ' || COALESCE(i.quality, '') || ' ' || COALESCE(n.name, '') || ' ' || CASE WHEN i.type = 'episode' THEN printf('s%02de%02d %dx%d', i.season, i.episode, i.season, i.episode) ELSE '' END) LIKE ?`);
    params.push(`%${token}%`);
  }
  if (filters.type) {
    conditions.push("i.type = ?");
    params.push(filters.type);
  }
  if (filters.resolution === "4k") {
    conditions.push("(LOWER(i.resolution) LIKE '%2160%' OR LOWER(i.resolution) LIKE '%4k%' OR CAST(json_extract(ins.report, '$.height') AS INTEGER) >= 2160)");
  }
  if (filters.resolution === "1080p") {
    conditions.push("(LOWER(i.resolution) LIKE '%1080%' OR CAST(json_extract(ins.report, '$.height') AS INTEGER) BETWEEN 1000 AND 2159)");
  }
  if (filters.hdr === "hdr") conditions.push("json_extract(ins.report, '$.hdr') <> 'none'");
  if (filters.hdr === "sdr") conditions.push("json_extract(ins.report, '$.hdr') = 'none'");
  if (filters.codec) {
    const codecCondition = filters.codec === "hevc"
      ? "(LOWER(json_extract(ins.report, '$.videoCodec')) LIKE '%hevc%' OR LOWER(json_extract(ins.report, '$.videoCodec')) LIKE '%h265%')"
      : `LOWER(json_extract(ins.report, '$.videoCodec')) LIKE ?`;
    conditions.push(codecCondition);
    if (filters.codec !== "hevc") params.push(`%${filters.codec}%`);
  }
  if (filters.overCap !== undefined) {
    const comparison = filters.overCap ? ">" : "<=";
    conditions.push(`CAST(json_extract(ins.report, '$.sizePerHourGb') AS REAL) ${comparison} CASE json_extract(s.payload, '$.category')
      WHEN 'movie1080p' THEN ? WHEN 'movie4kSdr' THEN ? WHEN 'movie4kHdr' THEN ? WHEN 'tv1080p' THEN ? WHEN 'tv4k' THEN ? WHEN 'tv4kHdr' THEN ? END`);
    params.push(
      settings.sizeCaps.movie1080p,
      settings.sizeCaps.movie4kSdr,
      settings.sizeCaps.movie4kHdr,
      settings.sizeCaps.tv1080p,
      settings.sizeCaps.tv4k,
      settings.sizeCaps.tv4kHdr,
    );
  }
  if (filters.extraTracks !== undefined) {
    conditions.push(`${filters.extraTracks ? "" : "NOT "}EXISTS (SELECT 1 FROM json_each(s.payload, '$.actions') WHERE value = 'tracks')`);
  }
  if (filters.exempt !== undefined) conditions.push(`i.size_exempt = ${filters.exempt ? 1 : 0}`);
  if (filters.hardwareWarning !== undefined) {
    conditions.push(`${filters.hardwareWarning ? "" : "NOT "}COALESCE(json_extract(s.payload, '$.warning'), '') LIKE 'Hardware encode is unavailable.%'`);
  }
  return { where: conditions.join(" AND "), params };
}
