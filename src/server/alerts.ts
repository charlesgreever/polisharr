import { randomUUID } from "node:crypto";
import { sendSmtp, type OutboundMail, type SmtpAccount, type SmtpSecurity } from "./smtp.ts";

export type AlertEventName = "review-ready" | "still-waiting" | "job-failed" | "direct-write" | "replace-waiting";

export type AlertTitle = {
  title: string;
  sourceBytes: number | null;
  finishedBytes: number | null;
  sizePerHourGb: number | null;
  flagged: boolean;
  nodeName: string | null;
};

export type AlertPrefs = {
  reviewReady: boolean;
  stillWaiting: boolean;
  jobFailed: boolean;
  directWrite: boolean;
  replaceWaiting: boolean;
  quietEnabled: boolean;
  quietStart: string;
  quietEnd: string;
  reminderTime: string;
  reviewUrl: string;
  digestMinutes: number;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: SmtpSecurity;
  smtpUsername: string;
  smtpFrom: string;
  smtpTo: string;
};

export const DEFAULT_ALERT_PREFS: AlertPrefs = {
  reviewReady: true,
  stillWaiting: true,
  jobFailed: true,
  directWrite: true,
  replaceWaiting: true,
  quietEnabled: false,
  quietStart: "23:00",
  quietEnd: "07:00",
  reminderTime: "08:00",
  reviewUrl: "",
  digestMinutes: 15,
  smtpHost: "",
  smtpPort: 587,
  smtpSecurity: "starttls",
  smtpUsername: "",
  smtpFrom: "",
  smtpTo: "",
};

export type StoredBatch = {
  id: string;
  event: AlertEventName;
  sendAfter: number;
  count: number;
  flagged: number;
  titles: string[];
  files: AlertTitle[];
  error: string | null;
  nodeName: string | null;
  sentWebhook: boolean;
  sentEmail: boolean;
  sentDiscord: boolean;
};

export type AlertState = {
  prefs: AlertPrefs;
  outbox: StoredBatch[];
  lastError: string | null;
  lastReminderDay: string | null;
};

export type AlertGateway = {
  load: () => AlertState;
  save: (state: AlertState) => void;
  webhook: () => { url: string; token: string } | null;
  pendingReviews: () => { count: number; flagged: number };
  smtp?: () => SmtpAccount | null;
  hasSmtpPassword?: () => boolean;
  discord?: () => string | null;
};

export type AlertSink = {
  noteReview(title: AlertTitle, at: number): void;
  noteFailure(input: { title: string; error: string; nodeName: string | null }, at: number): void;
  noteDirectWrite(input: { title: string; sourceBytes: number | null; finishedBytes: number | null }, at: number): void;
  noteReplaceWaiting(input: { title: string }, at: number): void;
};

export type PublicAlerts = AlertPrefs & {
  hasWebhookUrl: boolean;
  hasWebhookToken: boolean;
  hasSmtpPassword: boolean;
  hasDiscordWebhook: boolean;
  lastError: string | null;
};

export type AlertUpdate = {
  prefs: AlertPrefs;
  webhookUrl: string | null | undefined;
  webhookToken: string | null | undefined;
  smtpPassword: string | null | undefined;
  discordUrl: string | null | undefined;
};

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const TITLE_CAP = 8;

export function defaultAlertState(): AlertState {
  return { prefs: { ...DEFAULT_ALERT_PREFS }, outbox: [], lastError: null, lastReminderDay: null };
}

export function parseAlertState(value: unknown): AlertState {
  const raw = record(value);
  const prefsRaw = record(raw.prefs);
  const prefs = { ...DEFAULT_ALERT_PREFS };
  for (const field of ["reviewReady", "stillWaiting", "jobFailed", "directWrite", "replaceWaiting", "quietEnabled"] as const) {
    if (typeof prefsRaw[field] === "boolean") prefs[field] = prefsRaw[field];
  }
  for (const field of ["quietStart", "quietEnd", "reminderTime"] as const) {
    if (typeof prefsRaw[field] === "string" && CLOCK.test(prefsRaw[field])) prefs[field] = prefsRaw[field];
  }
  if (typeof prefsRaw.reviewUrl === "string" && (prefsRaw.reviewUrl === "" || httpUrl(prefsRaw.reviewUrl))) prefs.reviewUrl = prefsRaw.reviewUrl;
  if (typeof prefsRaw.digestMinutes === "number" && integerInRange(prefsRaw.digestMinutes, 1, 120)) prefs.digestMinutes = prefsRaw.digestMinutes;
  if (typeof prefsRaw.smtpHost === "string" && smtpHostOk(prefsRaw.smtpHost)) prefs.smtpHost = prefsRaw.smtpHost;
  if (typeof prefsRaw.smtpPort === "number" && integerInRange(prefsRaw.smtpPort, 1, 65535)) prefs.smtpPort = prefsRaw.smtpPort;
  if (prefsRaw.smtpSecurity === "starttls" || prefsRaw.smtpSecurity === "tls") prefs.smtpSecurity = prefsRaw.smtpSecurity;
  if (typeof prefsRaw.smtpUsername === "string") prefs.smtpUsername = prefsRaw.smtpUsername;
  if (typeof prefsRaw.smtpFrom === "string" && (prefsRaw.smtpFrom === "" || emailAddress(prefsRaw.smtpFrom))) prefs.smtpFrom = prefsRaw.smtpFrom;
  if (typeof prefsRaw.smtpTo === "string" && (prefsRaw.smtpTo === "" || emailAddress(prefsRaw.smtpTo))) prefs.smtpTo = prefsRaw.smtpTo;
  const outbox = Array.isArray(raw.outbox) ? raw.outbox.flatMap((row) => parseBatch(row)) : [];
  return {
    prefs,
    outbox,
    lastError: typeof raw.lastError === "string" ? raw.lastError : null,
    lastReminderDay: typeof raw.lastReminderDay === "string" ? raw.lastReminderDay : null,
  };
}

export function readAlertUpdate(current: AlertPrefs, value: unknown): { ok: true; update: AlertUpdate } | { ok: false; error: string } {
  const raw = record(value);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Notification settings must be a JSON object." };
  }
  const prefs = { ...current };
  for (const field of ["reviewReady", "stillWaiting", "jobFailed", "directWrite", "replaceWaiting", "quietEnabled"] as const) {
    if (!(field in raw)) continue;
    if (typeof raw[field] !== "boolean") return { ok: false, error: `The ${field} notification setting is invalid.` };
    prefs[field] = raw[field];
  }
  for (const field of ["quietStart", "quietEnd", "reminderTime"] as const) {
    if (!(field in raw)) continue;
    if (typeof raw[field] !== "string" || !CLOCK.test(raw[field])) return { ok: false, error: `The ${field} notification setting is invalid.` };
    prefs[field] = raw[field];
  }
  if ("reviewUrl" in raw) {
    if (typeof raw.reviewUrl !== "string" || (raw.reviewUrl !== "" && !httpUrl(raw.reviewUrl))) {
      return { ok: false, error: "The Review link must start with http:// or https://." };
    }
    prefs.reviewUrl = raw.reviewUrl;
  }
  if ("digestMinutes" in raw) {
    if (!integerInRange(raw.digestMinutes, 1, 120)) return { ok: false, error: "The digest window must be from 1 to 120 minutes." };
    prefs.digestMinutes = raw.digestMinutes;
  }
  if ("smtpHost" in raw) {
    if (typeof raw.smtpHost !== "string" || !smtpHostOk(raw.smtpHost)) return { ok: false, error: "The mail server address is invalid." };
    prefs.smtpHost = raw.smtpHost.trim();
  }
  if ("smtpPort" in raw) {
    if (!integerInRange(raw.smtpPort, 1, 65535)) return { ok: false, error: "The mail server port must be from 1 to 65535." };
    prefs.smtpPort = raw.smtpPort;
  }
  if ("smtpSecurity" in raw) {
    if (raw.smtpSecurity !== "starttls" && raw.smtpSecurity !== "tls") return { ok: false, error: "Mail security must be STARTTLS or implicit TLS." };
    prefs.smtpSecurity = raw.smtpSecurity;
  }
  if ("smtpUsername" in raw) {
    if (typeof raw.smtpUsername !== "string") return { ok: false, error: "The mailbox username is invalid." };
    prefs.smtpUsername = raw.smtpUsername;
  }
  if ("smtpFrom" in raw) {
    if (typeof raw.smtpFrom !== "string" || (raw.smtpFrom !== "" && !emailAddress(raw.smtpFrom))) return { ok: false, error: "The From address must be a mailbox address." };
    prefs.smtpFrom = raw.smtpFrom.trim();
  }
  if ("smtpTo" in raw) {
    if (typeof raw.smtpTo !== "string" || (raw.smtpTo !== "" && !emailAddress(raw.smtpTo))) return { ok: false, error: "The To address must be a mailbox address." };
    prefs.smtpTo = raw.smtpTo.trim();
  }
  let discordUrl: string | null | undefined;
  if ("discordUrl" in raw) {
    if (raw.discordUrl === "" || raw.discordUrl === null) discordUrl = null;
    else if (typeof raw.discordUrl === "string" && httpUrl(raw.discordUrl)) discordUrl = raw.discordUrl;
    else return { ok: false, error: "The Discord webhook must start with http:// or https://." };
  }
  let smtpPassword: string | null | undefined;
  if ("smtpPassword" in raw) {
    if (raw.smtpPassword === "" || raw.smtpPassword === null) smtpPassword = null;
    else if (typeof raw.smtpPassword === "string") smtpPassword = raw.smtpPassword;
    else return { ok: false, error: "The mailbox password is invalid." };
  }
  let webhookUrl: string | null | undefined;
  if ("webhookUrl" in raw) {
    if (raw.webhookUrl === "" || raw.webhookUrl === null) webhookUrl = null;
    else if (typeof raw.webhookUrl === "string" && httpUrl(raw.webhookUrl)) webhookUrl = raw.webhookUrl;
    else return { ok: false, error: "The webhook URL must start with http:// or https://." };
  }
  let webhookToken: string | null | undefined;
  if ("webhookToken" in raw) {
    if (raw.webhookToken === "" || raw.webhookToken === null) webhookToken = null;
    else if (typeof raw.webhookToken === "string") webhookToken = raw.webhookToken;
    else return { ok: false, error: "The webhook token is invalid." };
  }
  return { ok: true, update: { prefs, webhookUrl, webhookToken, smtpPassword, discordUrl } };
}

export class AlertService {
  constructor(
    private readonly gateway: AlertGateway,
    private readonly now: () => number,
    private readonly zone: string,
    private readonly mailer: (account: SmtpAccount, message: OutboundMail) => Promise<{ ok: true } | { ok: false; error: string }> = sendSmtp,
  ) {}

  publicView(): PublicAlerts {
    const state = this.gateway.load();
    const hook = this.gateway.webhook();
    return {
      ...state.prefs,
      hasWebhookUrl: Boolean(hook?.url),
      hasWebhookToken: Boolean(hook?.token),
      hasSmtpPassword: this.gateway.hasSmtpPassword?.() ?? Boolean(this.gateway.smtp?.()?.password),
      hasDiscordWebhook: Boolean(this.gateway.discord?.()),
      lastError: state.lastError,
    };
  }

  private timer: ReturnType<typeof setInterval> | undefined;

  replacePrefs(prefs: AlertPrefs): void {
    const state = this.gateway.load();
    this.gateway.save({ ...state, prefs });
  }

  start(httpFetch: typeof fetch, everyMs = 30_000): void {
    this.stop();
    this.timer = setInterval(() => {
      void this.flush(httpFetch);
    }, everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  noteReview(title: AlertTitle, at: number): void {
    const state = this.gateway.load();
    if (!state.prefs.reviewReady) return;
    const existing = state.outbox.find((batch) => batch.event === "review-ready");
    const sendAfter = this.readyAt(at, state.prefs.digestMinutes * 60_000, state.prefs);
    if (!existing) {
      state.outbox.push(batch("review-ready", sendAfter, title));
    } else {
      existing.count += 1;
      if (title.flagged) existing.flagged += 1;
      if (existing.titles.length < TITLE_CAP) existing.titles.push(title.title);
      if (existing.files.length < TITLE_CAP) existing.files.push(title);
      existing.sendAfter = Math.max(existing.sendAfter, sendAfter);
    }
    this.gateway.save(state);
  }

  noteFailure(input: { title: string; error: string; nodeName: string | null }, at: number): void {
    this.noteSingle("job-failed", input.title, input.error, input.nodeName, at, (prefs) => prefs.jobFailed);
  }

  noteDirectWrite(input: { title: string; sourceBytes: number | null; finishedBytes: number | null }, at: number): void {
    this.noteSingle("direct-write", input.title, null, null, at, (prefs) => prefs.directWrite, {
      title: input.title,
      sourceBytes: input.sourceBytes,
      finishedBytes: input.finishedBytes,
      sizePerHourGb: null,
      flagged: false,
      nodeName: null,
    });
  }

  noteReplaceWaiting(input: { title: string }, at: number): void {
    this.noteSingle("replace-waiting", input.title, null, null, at, (prefs) => prefs.replaceWaiting);
  }

  async flush(httpFetch: typeof fetch): Promise<void> {
    const state = this.gateway.load();
    this.queueReminder(state, this.now());
    const hook = this.gateway.webhook();
    const account = this.gateway.smtp?.() ?? null;
    const discord = this.gateway.discord?.() ?? null;
    if (!hook && !account && !discord) {
      this.gateway.save(state);
      return;
    }
    const now = this.now();
    let error: string | null = null;
    const remain: StoredBatch[] = [];
    for (const item of state.outbox) {
      if (!eventEnabled(state.prefs, item.event)) continue;
      if (item.sendAfter > now) {
        remain.push(item);
        continue;
      }
      let held = false;
      if (hook && !item.sentWebhook) {
        const result = await postAlert(hook, payloadFor(item, state.prefs.reviewUrl), httpFetch);
        if (result.ok) item.sentWebhook = true;
        else {
          error = result.error;
          held = true;
        }
      }
      if (account && !item.sentEmail) {
        const result = await this.mailer(account, mailFor(payloadFor(item, state.prefs.reviewUrl)));
        if (result.ok) item.sentEmail = true;
        else {
          error = result.error;
          held = true;
        }
      }
      if (discord && !item.sentDiscord) {
        const result = await postDiscord(discord, payloadFor(item, state.prefs.reviewUrl), httpFetch);
        if (result.ok) item.sentDiscord = true;
        else {
          error = result.error;
          held = true;
        }
      }
      if (held) remain.push(item);
      else if (item.event === "still-waiting") state.lastReminderDay = zonedClock(now, this.zone).day;
    }
    state.outbox = remain;
    state.lastError = error;
    this.gateway.save(state);
  }

  async sendTest(httpFetch: typeof fetch): Promise<{ ok: true } | { ok: false; error: string }> {
    const hook = this.gateway.webhook();
    if (!hook) return { ok: false, error: "Add a webhook URL first." };
    const state = this.gateway.load();
    const result = await postAlert(hook, {
      event: "review-ready",
      title: "Polisharr test",
      count: 1,
      flagged: 0,
      reviewUrl: state.prefs.reviewUrl,
      error: null,
      titles: ["Polisharr test"],
      files: [],
      nodeName: null,
    }, httpFetch);
    state.lastError = result.ok ? null : result.error;
    this.gateway.save(state);
    return result;
  }

  async sendTestDiscord(httpFetch: typeof fetch): Promise<{ ok: true } | { ok: false; error: string }> {
    const discord = this.gateway.discord?.() ?? null;
    if (!discord) return { ok: false, error: "Add a Discord webhook first." };
    const state = this.gateway.load();
    const result = await postDiscord(discord, {
      event: "review-ready",
      title: "Polisharr test",
      count: 1,
      flagged: 0,
      reviewUrl: state.prefs.reviewUrl,
      error: null,
      titles: ["Polisharr test"],
      files: [],
      nodeName: null,
    }, httpFetch);
    state.lastError = result.ok ? null : result.error;
    this.gateway.save(state);
    return result;
  }

  async sendTestEmail(): Promise<{ ok: true } | { ok: false; error: string }> {
    const account = this.gateway.smtp?.() ?? null;
    if (!account) return { ok: false, error: "Finish the mail server settings first." };
    const state = this.gateway.load();
    const result = await this.mailer(account, {
      subject: "Polisharr test",
      text: "Polisharr test\n",
      html: "<p>Polisharr test</p>",
    });
    state.lastError = result.ok ? null : result.error;
    this.gateway.save(state);
    return result;
  }

  private noteSingle(
    event: AlertEventName,
    title: string,
    error: string | null,
    nodeName: string | null,
    at: number,
    enabled: (prefs: AlertPrefs) => boolean,
    file?: AlertTitle,
  ): void {
    const state = this.gateway.load();
    if (!enabled(state.prefs)) return;
    const row = batch(event, this.readyAt(at, 0, state.prefs), file ?? {
      title,
      sourceBytes: null,
      finishedBytes: null,
      sizePerHourGb: null,
      flagged: false,
      nodeName,
    });
    row.error = error;
    row.nodeName = nodeName;
    state.outbox.push(row);
    this.gateway.save(state);
  }

  private queueReminder(state: AlertState, now: number): void {
    if (!state.prefs.stillWaiting) return;
    if (state.outbox.some((item) => item.event === "still-waiting")) return;
    const clock = zonedClock(now, this.zone);
    if (state.lastReminderDay === clock.day) return;
    if (clock.minutes < clockMinutes(state.prefs.reminderTime)) return;
    if (state.prefs.quietEnabled && inQuiet(clock.minutes, state.prefs.quietStart, state.prefs.quietEnd)) return;
    const pending = this.gateway.pendingReviews();
    if (pending.count <= 0) return;
    const row = batch("still-waiting", now, {
      title: waitingTitle(pending.count),
      sourceBytes: null,
      finishedBytes: null,
      sizePerHourGb: null,
      flagged: pending.flagged > 0,
      nodeName: null,
    });
    row.count = pending.count;
    row.flagged = pending.flagged;
    row.titles = [waitingTitle(pending.count)];
    state.outbox.push(row);
  }

  private readyAt(at: number, delayMs: number, prefs: AlertPrefs): number {
    const sendAt = at + delayMs;
    if (!prefs.quietEnabled) return sendAt;
    const clock = zonedClock(sendAt, this.zone);
    if (!inQuiet(clock.minutes, prefs.quietStart, prefs.quietEnd)) return sendAt;
    for (let step = 1; step <= 24 * 60 + 5; step += 1) {
      const candidate = sendAt + step * 60_000;
      const next = zonedClock(candidate, this.zone);
      if (!inQuiet(next.minutes, prefs.quietStart, prefs.quietEnd)) return candidate;
    }
    return sendAt;
  }
}

function batch(event: AlertEventName, sendAfter: number, title: AlertTitle): StoredBatch {
  return {
    id: randomUUID(),
    event,
    sendAfter,
    count: 1,
    flagged: title.flagged ? 1 : 0,
    titles: [title.title],
    files: [title],
    error: null,
    nodeName: title.nodeName,
    sentWebhook: false,
    sentEmail: false,
    sentDiscord: false,
  };
}

function payloadFor(item: StoredBatch, reviewUrl: string): AlertPayload {
  const title = item.event === "review-ready" || item.event === "still-waiting"
    ? (item.count === 1 ? item.titles[0] ?? "A file is waiting in Review" : waitingTitle(item.count))
    : item.titles[0] ?? "Polisharr";
  return {
    event: item.event,
    title,
    count: item.count,
    flagged: item.flagged,
    reviewUrl,
    error: item.error,
    titles: item.titles,
    files: item.files,
    nodeName: item.nodeName,
  };
}

type AlertPayload = {
  event: AlertEventName;
  title: string;
  count: number;
  flagged: number;
  reviewUrl: string;
  error: string | null;
  titles: string[];
  files: AlertTitle[];
  nodeName: string | null;
};

async function postAlert(
  hook: { url: string; token: string },
  payload: AlertPayload,
  httpFetch: typeof fetch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (hook.token) headers.authorization = `Bearer ${hook.token}`;
    const response = await httpFetch(hook.url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { ok: false, error: `The webhook returned HTTP ${response.status}.` };
    return { ok: true };
  } catch {
    return { ok: false, error: "The webhook did not answer." };
  }
}

async function postDiscord(
  url: string,
  payload: AlertPayload,
  httpFetch: typeof fetch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await httpFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ embeds: [discordEmbed(payload)] }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { ok: false, error: `Discord returned HTTP ${response.status}.` };
    return { ok: true };
  } catch {
    return { ok: false, error: "Discord did not answer." };
  }
}

function discordEmbed(payload: AlertPayload): { title: string; url?: string; description: string; color: number; footer?: { text: string } } {
  const lines = payload.files.length > 0
    ? payload.files.map((file) => fileLine(file))
    : payload.titles;
  if (payload.error) lines.unshift(payload.error);
  if (payload.flagged > 0 && payload.files.length === 0) lines.push(`${payload.flagged} flagged.`);
  return {
    title: payload.title,
    ...(payload.reviewUrl ? { url: payload.reviewUrl } : {}),
    description: lines.join("\n").slice(0, 4000),
    color: payload.event === "job-failed" ? 0xb42318 : payload.flagged > 0 ? 0xb54708 : 0x067647,
    ...(payload.nodeName ? { footer: { text: payload.nodeName } } : {}),
  };
}

function waitingTitle(count: number): string {
  return count === 1 ? "1 file is waiting in Review" : `${count} files are waiting in Review`;
}

function eventEnabled(prefs: AlertPrefs, event: AlertEventName): boolean {
  if (event === "review-ready") return prefs.reviewReady;
  if (event === "still-waiting") return prefs.stillWaiting;
  if (event === "job-failed") return prefs.jobFailed;
  if (event === "direct-write") return prefs.directWrite;
  return prefs.replaceWaiting;
}

function inQuiet(minutes: number, start: string, end: string): boolean {
  const from = clockMinutes(start);
  const to = clockMinutes(end);
  if (from === to) return false;
  if (from < to) return minutes >= from && minutes < to;
  return minutes >= from || minutes < to;
}

function clockMinutes(value: string): number {
  const [hour, minute] = value.split(":");
  return Number(hour) * 60 + Number(minute);
}

function zonedClock(now: number, zone: string): { day: string; minutes: number } {
  const bag: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(now)) {
    bag[part.type] = part.value;
  }
  let hour = Number(bag.hour);
  if (hour === 24) hour = 0;
  return {
    day: `${bag.year}-${bag.month}-${bag.day}`,
    minutes: hour * 60 + Number(bag.minute),
  };
}

function parseBatch(value: unknown): StoredBatch[] {
  const raw = record(value);
  const event = raw.event;
  if (event !== "review-ready" && event !== "still-waiting" && event !== "job-failed" && event !== "direct-write" && event !== "replace-waiting") return [];
  if (typeof raw.id !== "string" || typeof raw.sendAfter !== "number") return [];
  const titles = Array.isArray(raw.titles) ? raw.titles.filter((title): title is string => typeof title === "string") : [];
  const files = Array.isArray(raw.files) ? raw.files.flatMap((row) => {
    const file = parseTitle(row);
    return file ? [file] : [];
  }) : [];
  return [{
    id: raw.id,
    event,
    sendAfter: raw.sendAfter,
    count: typeof raw.count === "number" ? raw.count : titles.length,
    flagged: typeof raw.flagged === "number" ? raw.flagged : 0,
    titles,
    files,
    error: typeof raw.error === "string" ? raw.error : null,
    nodeName: typeof raw.nodeName === "string" ? raw.nodeName : null,
    sentWebhook: raw.sentWebhook === true,
    sentEmail: raw.sentEmail === true,
    sentDiscord: raw.sentDiscord === true,
  }];
}

function mailFor(payload: AlertPayload): OutboundMail {
  const lines = [payload.title];
  if (payload.error) lines.push(payload.error);
  if (payload.files.length > 0) {
    for (const file of payload.files) lines.push(fileLine(file));
  } else {
    for (const title of payload.titles) lines.push(title);
  }
  if (payload.flagged > 0) lines.push(`${payload.flagged} flagged.`);
  if (payload.nodeName) lines.push(`Node: ${payload.nodeName}`);
  if (payload.reviewUrl) lines.push(`Review: ${payload.reviewUrl}`);
  const text = `${lines.join("\n")}\n`;
  const htmlLines = lines.map((line) => `<p>${escapeHtml(line)}</p>`);
  if (payload.reviewUrl) {
    htmlLines[htmlLines.length - 1] = `<p><a href="${escapeHtml(payload.reviewUrl)}">Open Review</a></p>`;
  }
  return { subject: payload.title, text, html: htmlLines.join("") };
}

function fileLine(file: AlertTitle): string {
  const parts = [file.title];
  if (file.sourceBytes != null || file.finishedBytes != null) {
    parts.push(`${formatBytes(file.sourceBytes)} to ${formatBytes(file.finishedBytes)}`);
  }
  if (file.sizePerHourGb != null) parts.push(`${file.sizePerHourGb.toFixed(2)} GB per hour`);
  if (file.flagged) parts.push("Missed the size target.");
  return parts.join(". ");
}

function formatBytes(bytes: number | null): string {
  if (bytes == null) return "unknown size";
  const gb = bytes / 1_000_000_000;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1_000_000)} MB`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function smtpHostOk(value: string): boolean {
  return value === "" || (value.length <= 253 && !value.includes("://") && !/\s/.test(value));
}

function emailAddress(value: string): boolean {
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(value);
}

function parseTitle(value: unknown): AlertTitle | null {
  const raw = record(value);
  if (typeof raw.title !== "string") return null;
  return {
    title: raw.title,
    sourceBytes: typeof raw.sourceBytes === "number" ? raw.sourceBytes : null,
    finishedBytes: typeof raw.finishedBytes === "number" ? raw.finishedBytes : null,
    sizePerHourGb: typeof raw.sizePerHourGb === "number" ? raw.sizePerHourGb : null,
    flagged: raw.flagged === true,
    nodeName: typeof raw.nodeName === "string" ? raw.nodeName : null,
  };
}

function httpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function integerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
