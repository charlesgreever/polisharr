import { useEffect, useState } from "react";
import { api, type AlertSettings } from "../api";
import { FIELD_CONTROL } from "../settings-copy";
import { Tip } from "./ui";

const EMPTY_ALERTS: AlertSettings = {
  reviewReady: true,
  stillWaiting: true,
  jobFailed: true,
  directWrite: true,
  replaceWaiting: false,
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
  hasWebhookUrl: false,
  hasWebhookToken: false,
  hasSmtpPassword: false,
  hasDiscordWebhook: false,
  lastError: null,
};

const EVENTS: Array<{ key: "reviewReady" | "stillWaiting" | "jobFailed" | "directWrite" | "replaceWaiting"; label: string }> = [
  { key: "reviewReady", label: "Tell me when a finished file is waiting in Review" },
  { key: "stillWaiting", label: "Remind me once a day while Review still has files" },
  { key: "jobFailed", label: "Tell me when a job fails" },
  { key: "directWrite", label: "Tell me when a direct write has replaced a library file" },
  { key: "replaceWaiting", label: "Tell me when Keep or a direct write is waiting for playback to end" },
];

export function NotificationSettings({
  alerts = EMPTY_ALERTS,
  onSaved,
}: {
  alerts?: AlertSettings;
  onSaved: (message: string) => void;
}) {
  const [prefs, setPrefs] = useState(alerts);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookToken, setWebhookToken] = useState("");
  const [smtpPassword, setSmtpPassword] = useState("");
  const [discordUrl, setDiscordUrl] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPrefs(alerts);
  }, [alerts]);

  function patch(next: Partial<AlertSettings>) {
    setPrefs({ ...prefs, ...next });
  }

  async function run(work: () => Promise<void>, fallback: string) {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      onSaved(error instanceof Error ? error.message : fallback);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    await run(async () => {
      const body: Record<string, unknown> = {
        reviewReady: prefs.reviewReady,
        stillWaiting: prefs.stillWaiting,
        jobFailed: prefs.jobFailed,
        directWrite: prefs.directWrite,
        replaceWaiting: prefs.replaceWaiting,
        quietEnabled: prefs.quietEnabled,
        quietStart: prefs.quietStart,
        quietEnd: prefs.quietEnd,
        reminderTime: prefs.reminderTime,
        reviewUrl: prefs.reviewUrl.trim(),
        digestMinutes: prefs.digestMinutes,
        smtpHost: prefs.smtpHost.trim(),
        smtpPort: prefs.smtpPort,
        smtpSecurity: prefs.smtpSecurity,
        smtpUsername: prefs.smtpUsername,
        smtpFrom: prefs.smtpFrom.trim(),
        smtpTo: prefs.smtpTo.trim(),
      };
      if (webhookUrl.trim()) body.webhookUrl = webhookUrl.trim();
      if (webhookToken.trim()) body.webhookToken = webhookToken.trim();
      if (smtpPassword) body.smtpPassword = smtpPassword;
      if (discordUrl.trim()) body.discordUrl = discordUrl.trim();
      await api.saveSettings({ alerts: body });
      setWebhookUrl("");
      setWebhookToken("");
      setSmtpPassword("");
      setDiscordUrl("");
      onSaved("Notifications saved.");
    }, "Notifications could not be saved.");
  }

  async function sendTest() {
    await run(async () => {
      await api.testAlert();
      onSaved("Test message sent.");
    }, "The test message could not be sent.");
  }

  async function sendTestEmail() {
    await run(async () => {
      await api.testAlertEmail();
      onSaved("Test email sent.");
    }, "The test email could not be sent.");
  }

  async function sendTestDiscord() {
    await run(async () => {
      await api.testAlertDiscord();
      onSaved("Test Discord message sent.");
    }, "The Discord test could not be sent.");
  }

  async function clearWebhook() {
    await run(async () => {
      await api.saveSettings({ alerts: { webhookUrl: "", webhookToken: "", discordUrl: "" } });
      setWebhookUrl("");
      setWebhookToken("");
      setDiscordUrl("");
      onSaved("Saved webhooks cleared.");
    }, "The saved webhook could not be cleared.");
  }

  return (
    <div className="glass space-y-3 p-4">
      <h2 className="flex items-center gap-1 font-semibold">
        Notifications
        <Tip label="Notifications">Polisharr sends a message when a finished file is waiting in Review, when a job fails, and when a direct write has already replaced a library file. Several Review finishes inside the digest window share one message. The computer that holds your library sends these messages. A joined GPU box keeps encoding.</Tip>
      </h2>
      {EVENTS.map((event) => (
        <label key={event.key} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={prefs[event.key]}
            onChange={(change) => patch({ [event.key]: change.target.checked })}
          />
          {event.label}
        </label>
      ))}
      <label className="block space-y-1.5 text-sm">
        <span className="flex items-center gap-1 font-medium text-muted">
          Review link
          <Tip label="Review link">Type the address you use to open Polisharr. Messages include this link.</Tip>
        </span>
        <input
          className={FIELD_CONTROL}
          value={prefs.reviewUrl}
          placeholder="http://192.168.1.10:7373"
          onChange={(event) => patch({ reviewUrl: event.target.value })}
        />
      </label>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium text-muted">Daily reminder</span>
          <input className={FIELD_CONTROL} value={prefs.reminderTime} onChange={(event) => patch({ reminderTime: event.target.value })} />
        </label>
        <label className="block space-y-1.5 text-sm">
          <span className="flex items-center gap-1 font-medium text-muted">
            Digest window (minutes)
            <Tip label="Digest window">Polisharr waits this many minutes so several Review finishes can share one message. Each new finish starts the wait again.</Tip>
          </span>
          <input
            className={FIELD_CONTROL}
            type="number"
            min={1}
            max={120}
            value={prefs.digestMinutes}
            onChange={(event) => patch({ digestMinutes: Number(event.target.value) })}
          />
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={prefs.quietEnabled}
          onChange={(event) => patch({ quietEnabled: event.target.checked })}
        />
        Hold messages during quiet hours
        <Tip label="Quiet hours">The next open minute sends what was waiting. This clock is separate from the encode off-peak window.</Tip>
      </label>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium text-muted">Quiet hours start</span>
          <input className={FIELD_CONTROL} value={prefs.quietStart} onChange={(event) => patch({ quietStart: event.target.value })} />
        </label>
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium text-muted">Quiet hours end</span>
          <input className={FIELD_CONTROL} value={prefs.quietEnd} onChange={(event) => patch({ quietEnd: event.target.value })} />
        </label>
      </div>
      <label className="block space-y-1.5 text-sm">
        <span className="flex items-center gap-1 font-medium text-muted">
          Webhook URL
          <Tip label="Webhook URL">A webhook is a web address that receives a message. Home Assistant can turn that message into a phone notification. ntfy can show it when you use a long private topic address. Leave these boxes blank to keep the saved address and token. Polisharr stores them encrypted and leaves the Review copy and the library file as they are when the receiver is down.</Tip>
        </span>
        <input
          className={FIELD_CONTROL}
          value={webhookUrl}
          placeholder={alerts.hasWebhookUrl ? "A webhook address is saved" : "https://example.test/hook"}
          onChange={(event) => setWebhookUrl(event.target.value)}
        />
      </label>
      <label className="block space-y-1.5 text-sm">
        <span className="font-medium text-muted">Webhook token</span>
        <input
          className={FIELD_CONTROL}
          type="password"
          value={webhookToken}
          placeholder={alerts.hasWebhookToken ? "A token is saved" : "Optional"}
          onChange={(event) => setWebhookToken(event.target.value)}
          autoComplete="off"
        />
      </label>
      <h3 className="flex items-center gap-1 font-medium">
        Email
        <Tip label="Email">Polisharr sends mail through a mailbox you already read. Create an app password at that provider and put their submission host here. STARTTLS usually uses port 587. Implicit TLS usually uses port 465.</Tip>
      </h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium text-muted">Mail server</span>
          <input className={FIELD_CONTROL} value={prefs.smtpHost} placeholder="smtp.example.com" onChange={(event) => patch({ smtpHost: event.target.value })} />
        </label>
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium text-muted">Port</span>
          <input className={FIELD_CONTROL} type="number" min={1} max={65535} value={prefs.smtpPort} onChange={(event) => patch({ smtpPort: Number(event.target.value) })} />
        </label>
      </div>
      <label className="block space-y-1.5 text-sm">
        <span className="font-medium text-muted">Security</span>
        <select
          className={FIELD_CONTROL}
          value={prefs.smtpSecurity}
          onChange={(event) => {
            const smtpSecurity = event.target.value === "tls" ? "tls" : "starttls";
            const smtpPort = smtpSecurity === "tls"
              ? (prefs.smtpPort === 587 ? 465 : prefs.smtpPort)
              : (prefs.smtpPort === 465 ? 587 : prefs.smtpPort);
            patch({ smtpSecurity, smtpPort });
          }}
        >
          <option value="starttls">STARTTLS</option>
          <option value="tls">Implicit TLS</option>
        </select>
      </label>
      <label className="block space-y-1.5 text-sm">
        <span className="font-medium text-muted">Username</span>
        <input className={FIELD_CONTROL} value={prefs.smtpUsername} onChange={(event) => patch({ smtpUsername: event.target.value })} autoComplete="off" />
      </label>
      <label className="block space-y-1.5 text-sm">
        <span className="font-medium text-muted">Password</span>
        <input
          className={FIELD_CONTROL}
          type="password"
          value={smtpPassword}
          placeholder={alerts.hasSmtpPassword ? "A password is saved" : "App password"}
          onChange={(event) => setSmtpPassword(event.target.value)}
          autoComplete="new-password"
        />
      </label>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium text-muted">From</span>
          <input className={FIELD_CONTROL} value={prefs.smtpFrom} placeholder="polisharr@example.com" onChange={(event) => patch({ smtpFrom: event.target.value })} />
        </label>
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium text-muted">To</span>
          <input className={FIELD_CONTROL} value={prefs.smtpTo} placeholder="you@example.com" onChange={(event) => patch({ smtpTo: event.target.value })} />
        </label>
      </div>
      <h3 className="flex items-center gap-1 font-medium">
        Discord
        <Tip label="Discord">In the Discord channel, open Integrations, then Webhooks, then New Webhook, and paste that address here. Polisharr posts one summary a person can read on a phone. Keep and Discard stay on the Review page.</Tip>
      </h3>
      <label className="block space-y-1.5 text-sm">
        <span className="font-medium text-muted">Discord webhook</span>
        <input
          className={FIELD_CONTROL}
          type="password"
          value={discordUrl}
          placeholder={alerts.hasDiscordWebhook ? "A Discord webhook is saved" : "https://discord.com/api/webhooks/…"}
          onChange={(event) => setDiscordUrl(event.target.value)}
          autoComplete="off"
        />
      </label>
      {alerts.lastError && <p className="help">{alerts.lastError}</p>}
      <div className="flex flex-wrap gap-2">
        <button className="btn" type="button" disabled={busy} onClick={() => void save()}>Save notifications</button>
        <button className="btn" type="button" disabled={busy} onClick={() => void sendTest()}>Send test</button>
        <button className="btn" type="button" disabled={busy} onClick={() => void sendTestEmail()}>Send test email</button>
        <button className="btn" type="button" disabled={busy} onClick={() => void sendTestDiscord()}>Send Discord test</button>
        {(alerts.hasWebhookUrl || alerts.hasWebhookToken || alerts.hasDiscordWebhook) && (
          <button className="btn" type="button" disabled={busy} onClick={() => void clearWebhook()}>Clear saved webhooks</button>
        )}
      </div>
    </div>
  );
}
