import { useEffect, useState } from "react";
import { api, type FirstRun, type SettingsPayload } from "../api";
import { FIELD_CONTROL } from "../settings-copy";
import { ThemeToggle } from "../components/ThemeToggle";

export function SetupPage({ firstRun, onReady }: { firstRun: FirstRun; onReady: () => void }) {
  const [settings, setSettings] = useState<SettingsPayload | null>(null);
  const [language, setLanguage] = useState("eng");
  const [confirmed, setConfirmed] = useState(false);
  const [reviewPath, setReviewPath] = useState("");
  const [kind, setKind] = useState<"radarr" | "sonarr" | "plex" | "jellyfin">("radarr");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    void api.settings().then((payload) => {
      setSettings(payload);
      setLanguage(payload.preferredLanguage || "eng");
      setConfirmed(payload.languageConfirmed);
      setReviewPath(payload.reviewPath);
    }).catch((error: Error) => setMsg(error.message));
  }, []);

  const step = !firstRun.languageConfirmed ? "language" : !firstRun.hasReviewPath ? "review" : "arr";

  async function saveLanguage() {
    if (!settings) return;
    try {
      await api.saveSettings({ ...settings, preferredLanguage: language, languageConfirmed: confirmed });
      onReady();
      setMsg("");
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "Could not save language.");
    }
  }

  async function saveReview() {
    if (!settings) return;
    try {
      await api.saveSettings({ ...settings, reviewPath, languageConfirmed: true, preferredLanguage: language });
      onReady();
      setMsg("");
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "Could not save the review folder.");
    }
  }

  async function saveConnection() {
    try {
      const saved = await api.saveInstance({ kind, name, url, apiKey, enabled: false });
      if (kind === "radarr" || kind === "sonarr") {
        try {
          const result = await api.testInstance(saved.id);
          if (!result.ok) {
            setMsg(result.message || "That Radarr or Sonarr URL did not answer.");
            onReady();
            return;
          }
        } catch (error) {
          setMsg(error instanceof Error ? error.message : "That Radarr or Sonarr URL did not answer.");
          onReady();
          return;
        }
      }
      await api.saveInstance({ id: saved.id, kind, name, url, enabled: true });
      setName("");
      setUrl("");
      setApiKey("");
      onReady();
      setMsg(kind === "plex" || kind === "jellyfin" ? "Player saved. You can add another or finish after Radarr or Sonarr is connected." : "");
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "Could not save that connection.");
    }
  }

  return (
    <main className="auth-page relative">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <section className="auth-card max-w-lg space-y-5">
        <p className="eyebrow">FIRST RUN</p>
        <h1>Finish setup before optimize</h1>
        <p>
          Polisharr needs a preferred language, a review folder (where finished copies wait for Keep), and at least one enabled Radarr or Sonarr. Plex and Jellyfin can wait.
        </p>
        {step === "language" && (
          <div className="space-y-3">
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium">Preferred language</span>
              <input className={FIELD_CONTROL} value={language} onChange={(e) => setLanguage(e.target.value)} />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              I confirm this language before any track cleanup
            </label>
            <button className="btn" type="button" disabled={!confirmed} onClick={() => void saveLanguage()}>Save language</button>
          </div>
        )}
        {step === "review" && (
          <div className="space-y-3">
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium">Review folder</span>
              <input className={FIELD_CONTROL} value={reviewPath} onChange={(e) => setReviewPath(e.target.value)} placeholder="/mnt/nas/polisharr-review" />
            </label>
            <p className="help m-0">Finished copies land here until you Keep. Put it on the same share as the library, outside movie and show folders.</p>
            <button className="btn" type="button" disabled={!reviewPath.trim()} onClick={() => void saveReview()}>Save review folder</button>
          </div>
        )}
        {step === "arr" && (
          <div className="space-y-3">
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium">Kind</span>
              <select className={FIELD_CONTROL} value={kind} onChange={(e) => {
                const value = e.target.value;
                if (value === "radarr" || value === "sonarr" || value === "plex" || value === "jellyfin") setKind(value);
              }}>
                <option value="radarr">Radarr</option>
                <option value="sonarr">Sonarr</option>
                <option value="plex">Plex (optional)</option>
                <option value="jellyfin">Jellyfin (optional)</option>
              </select>
            </label>
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium">Name</span>
              <input className={FIELD_CONTROL} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium">URL</span>
              <input className={FIELD_CONTROL} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://radarr:7878" />
            </label>
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium">API key or token</span>
              <input className={FIELD_CONTROL} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            </label>
            <button className="btn" type="button" disabled={!name.trim() || !url.trim() || !apiKey.trim()} onClick={() => void saveConnection()}>
              Save connection
            </button>
            <p className="help m-0">Skip Plex and Jellyfin for now. Add them later in Settings. Home opens once Radarr or Sonarr is enabled.</p>
          </div>
        )}
        {msg && <div className="form-error">{msg}</div>}
      </section>
    </main>
  );
}
