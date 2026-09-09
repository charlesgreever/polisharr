import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseNodeRole, type NodeRole } from "./cluster.ts";

export type Env = {
  configDir: string;
  port: number;
  host: string;
  puid: number;
  pgid: number;
  tz: string;
  ffmpeg: string;
  ffprobe: string;
  mkvmerge: string;
  whisperLid: string | null;
  pgsOcr: string | null;
  webRoot: string;
  secretPath: string;
  dbPath: string;
  widgetKeyEnv: string | null;
  trustProxy: boolean;
  role: NodeRole;
  nodeName: string | null;
  masterUrl: string | null;
  clusterTokenEnv: string | null;
};

export function readAppVersion(cwd = process.cwd()): string {
  try {
    const raw = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { version?: unknown };
    return typeof raw.version === "string" && raw.version.trim() ? raw.version.trim() : "unknown";
  } catch {
    return "unknown";
  }
}

export function loadEnv(processEnv: NodeJS.ProcessEnv = process.env): Env {
  const configDir = processEnv.CONFIG_DIR ?? "./config";
  mkdirSync(configDir, { recursive: true });
  return {
    configDir,
    port: Number(processEnv.PORT ?? 7373),
    host: processEnv.HOST ?? "127.0.0.1",
    puid: Number(processEnv.PUID ?? 1000),
    pgid: Number(processEnv.PGID ?? 1000),
    tz: processEnv.TZ ?? "America/New_York",
    ffmpeg: processEnv.FFMPEG ?? "ffmpeg",
    ffprobe: processEnv.FFPROBE ?? "ffprobe",
    mkvmerge: processEnv.MKVMERGE ?? "mkvmerge",
    whisperLid: processEnv.WHISPER_LID?.trim() ? processEnv.WHISPER_LID.trim() : null,
    pgsOcr: processEnv.PGS_OCR?.trim() ? processEnv.PGS_OCR.trim() : null,
    webRoot: processEnv.WEB_ROOT ?? join(dirname(new URL(import.meta.url).pathname), "../../dist/web"),
    secretPath: join(configDir, ".secret"),
    dbPath: resolveDbPath(configDir),
    widgetKeyEnv: processEnv.POLISHARR_WIDGET_KEY ?? processEnv.OPTIMIZARR_WIDGET_KEY ?? null,
    trustProxy: processEnv.POLISHARR_TRUST_PROXY === "1" || processEnv.OPTIMIZARR_TRUST_PROXY === "1",
    role: parseNodeRole(processEnv.POLISHARR_ROLE),
    nodeName: processEnv.POLISHARR_NODE_NAME?.trim() ? processEnv.POLISHARR_NODE_NAME.trim() : null,
    masterUrl: processEnv.POLISHARR_MASTER_URL?.trim() ? processEnv.POLISHARR_MASTER_URL.trim() : null,
    clusterTokenEnv: processEnv.POLISHARR_CLUSTER_TOKEN?.trim() ? processEnv.POLISHARR_CLUSTER_TOKEN.trim() : null,
  };
}

function resolveDbPath(configDir: string): string {
  const next = join(configDir, "polisharr.db");
  const prev = join(configDir, "optimizarr.db");
  if (!existsSync(next) && existsSync(prev)) renameSync(prev, next);
  return next;
}
