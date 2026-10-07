import { connect as connectPlain, type Socket } from "node:net";
import { connect as connectTls, type TLSSocket } from "node:tls";
import { randomBytes } from "node:crypto";

export type SmtpSecurity = "starttls" | "tls";

export type SmtpAccount = {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  password: string;
  from: string;
  to: string;
  ca?: string;
};

export type OutboundMail = {
  subject: string;
  text: string;
  html: string;
};

type Delivery = { ok: true } | { ok: false; error: string };

class SmtpRefused extends Error {
  constructor(readonly code: number) {
    super(`smtp ${code}`);
  }
}

export async function sendSmtp(account: SmtpAccount, message: OutboundMail): Promise<Delivery> {
  if (!isMailboxAddress(account.from) || !isMailboxAddress(account.to)) {
    return { ok: false, error: "The From and To addresses must be mailbox addresses." };
  }
  const holder: { socket: Socket | null } = { socket: null };
  try {
    await withTimeout(submit(account, message, holder), holder);
    return { ok: true };
  } catch (error) {
    holder.socket?.destroy();
    if (error instanceof SmtpRefused) return { ok: false, error: `The mail server returned ${error.code}.` };
    return { ok: false, error: "The mail server did not answer." };
  }
}

async function submit(account: SmtpAccount, message: OutboundMail, holder: { socket: Socket | null }): Promise<void> {
  let socket: Socket = account.security === "tls"
    ? await openTls(account)
    : await openPlain(account);
  holder.socket = socket;
  let talk = new SmtpTalk(socket);
  await talk.expect(220);
  await talk.command("EHLO polisharr", 250);
  if (account.security === "starttls") {
    await talk.command("STARTTLS", 220);
    socket = await upgradeTls(socket, account);
    holder.socket = socket;
    talk = new SmtpTalk(socket);
    await talk.command("EHLO polisharr", 250);
  }
  const auth = Buffer.from(`\u0000${account.username}\u0000${account.password}`).toString("base64");
  await talk.command(`AUTH PLAIN ${auth}`, 235);
  await talk.command(`MAIL FROM:<${account.from}>`, 250);
  await talk.command(`RCPT TO:<${account.to}>`, 250);
  await talk.command("DATA", 354);
  await talk.sendData(mime(account, message));
  try {
    await talk.command("QUIT", 221);
  } catch {
    // The message is already accepted. A missing goodbye is not a failed send.
  }
}

function openPlain(account: SmtpAccount): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connectPlain({ host: account.host, port: account.port });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function tlsName(host: string): string | undefined {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ? undefined : host;
}

function openTls(account: SmtpAccount): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = connectTls({ host: account.host, port: account.port, servername: tlsName(account.host), ca: account.ca });
    socket.once("secureConnect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function upgradeTls(socket: Socket, account: SmtpAccount): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const secure = connectTls({ socket, servername: tlsName(account.host), ca: account.ca });
    secure.once("secureConnect", () => resolve(secure));
    secure.once("error", reject);
  });
}

function withTimeout(work: Promise<void>, holder: { socket: Socket | null }): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      holder.socket?.destroy();
      reject(new Error("timeout"));
    }, 10_000);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

class SmtpTalk {
  private buffer = "";
  private pending: Array<() => void> = [];
  private failed: Error | null = null;

  constructor(private readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      this.wake();
    });
    socket.on("error", (error) => {
      this.failed = error;
      this.wake();
    });
    socket.on("end", () => {
      this.failed ??= new Error("closed");
      this.wake();
    });
  }

  async expect(code: number): Promise<void> {
    const reply = await this.reply();
    if (reply !== code) throw new SmtpRefused(reply);
  }

  async command(line: string, code: number): Promise<void> {
    this.socket.write(`${line}\r\n`);
    await this.expect(code);
  }

  async sendData(body: string): Promise<void> {
    const stuffed = body.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
    this.socket.write(`${stuffed}\r\n.\r\n`);
    await this.expect(250);
  }

  private async reply(): Promise<number> {
    for (;;) {
      const found = takeReply(this.buffer);
      if (found) {
        this.buffer = found.rest;
        return found.code;
      }
      if (this.failed) throw this.failed;
      await new Promise<void>((resolve) => this.pending.push(resolve));
    }
  }

  private wake(): void {
    const pending = this.pending;
    this.pending = [];
    for (const resolve of pending) resolve();
  }
}

function takeReply(buffer: string): { code: number; rest: string } | null {
  let start = 0;
  while (start < buffer.length) {
    const nl = buffer.indexOf("\n", start);
    if (nl < 0) return null;
    const line = buffer.slice(start, nl).replace(/\r$/, "");
    if (/^\d{3} $/.test(line) || (line.length >= 4 && line[3] === " ")) {
      return { code: Number(line.slice(0, 3)), rest: buffer.slice(nl + 1) };
    }
    if (line.length >= 4 && line[3] === "-") {
      start = nl + 1;
      continue;
    }
    return null;
  }
  return null;
}

function mime(account: SmtpAccount, message: OutboundMail): string {
  const boundary = `polisharr-${randomBytes(8).toString("hex")}`;
  const subject = `=?UTF-8?B?${Buffer.from(oneLine(message.subject)).toString("base64")}?=`;
  return [
    `From: ${account.from}`,
    `To: ${account.to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    message.text,
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "",
    message.html,
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").slice(0, 200);
}

export function isMailboxAddress(value: string): boolean {
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(value);
}
