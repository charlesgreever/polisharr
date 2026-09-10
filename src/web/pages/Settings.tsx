import { useEffect, useState, type ReactNode } from "react";
import { api, type ClusterNode, type Exclusion, type FirstRun, type Hardware, type SettingsPayload } from "../api";
import { Help, PageHead } from "../components/Shell";
import { RefreshLibrary } from "../components/RefreshLibrary";
import { EncodeSettings } from "../components/EncodeSettings";
import { SuggestionDefaultsSettings } from "../components/SuggestionDefaultsSettings";
import { FIELD_CONTROL, SIZE_CAP_GRID } from "../settings-copy";

export function SettingsPage({ firstRun, onChange }: { firstRun: FirstRun; onChange: () => void }) {
  const [data, setData] = useState<SettingsPayload | null>(null);
  const [hw, setHw] = useState<Hardware | null>(null);
  const [msg, setMsg] = useState("");
  const [inst, setInst] = useState<{ kind: "radarr" | "sonarr" | "plex" | "jellyfin"; name: string; url: string; apiKey: string }>({
    kind: "radarr",
    name: "",
    url: "",
    apiKey: "",
  });
  const [exclusions, setExclusions] = useState<Exclusion[]>([]);
  const [exclusion, setExclusion] = useState<{ kind: Exclusion["kind"]; value: string }>({ kind: "path", value: "" });
  const [webhookToken, setWebhookToken] = useState<string | null>(null);
  const [widgetKey, setWidgetKey] = useState<string | null>(null);
  const [clusterToken, setClusterToken] = useState<string | null>(null);
  const [nodes, setNodes] = useState<ClusterNode[]>([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const load = () => void api.settings().then((payload) => {
    setData(payload);
    setUsername(payload.username ?? "");
  });
  useEffect(() => {
    load();
    void api.hardware().then(setHw);
    void api.exclusions().then((result) => setExclusions(result.exclusions));
    void api.nodes().then((payload) => setNodes(payload.nodes));
    const id = setInterval(() => {
      void api.nodes().then((payload) => setNodes(payload.nodes)).catch(() => undefined);
    }, 10_000);
    return () => clearInterval(id);
  }, []);

  const save = () => {
    if (!data) return;
    void api.saveSettings(data).then(() => {
      setMsg("Settings saved.");
      onChange();
    }).catch((error: Error) => setMsg(error.message));
  };

  if (!data) return <p>Loading settings…</p>;

  return (
    <section className="max-w-3xl space-y-6">
      <div>
        <PageHead title="Settings" />
        <Help>
          Preferred language decides which audio and subtitle tracks stay. Confirm it once before any optimize. The review folder is where finished copies wait for Keep; it must sit outside your movie and show libraries.
        </Help>
      </div>
      {!firstRun.complete && (
        <div className="glass border-amber-400/30 p-4 text-sm">
          First-run is incomplete.
          {!firstRun.languageConfirmed && " Confirm a preferred language."}
          {!firstRun.hasReviewPath && " Set a review folder."}
          {!firstRun.hasArr && " Connect an enabled Radarr or Sonarr."}
        </div>
      )}
      <div className="glass space-y-4 p-5">
        <h2 className="font-semibold">Language and review</h2>
        <Field label="Preferred language">
          <input className={FIELD_CONTROL} value={data.preferredLanguage} onChange={(e) => setData({ ...data, preferredLanguage: e.target.value })} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={data.languageConfirmed} onChange={(e) => setData({ ...data, languageConfirmed: e.target.checked })} />
          I confirm this language before any track cleanup
        </label>
        <Field label="Review folder">
          <input className={FIELD_CONTROL} value={data.reviewPath} onChange={(e) => setData({ ...data, reviewPath: e.target.value })} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={data.localAuthBypass} onChange={(e) => setData({ ...data, localAuthBypass: e.target.checked })} />
          Allow local addresses without a password
        </label>
        <Field label="Write finished files">
          <select className={FIELD_CONTROL} value={data.writeMode ?? "sidecar"} onChange={(e) => {
            const value = e.target.value;
            if (value !== "sidecar" && value !== "direct") return;
            const next = { ...data, writeMode: value as "sidecar" | "direct" };
            setData(next);
            void api.saveSettings(next).then(() => {
              setMsg(value === "direct"
                ? "Direct write saved. Waiting bulk jobs replace the library file after the integrity check."
                : "Sidecar write saved. Finished copies wait in Review for Keep.");
              onChange();
            }).catch((error: Error) => setMsg(error.message));
          }}>
            <option value="sidecar">Sidecar for Review (default)</option>
            <option value="direct">Direct write after integrity check</option>
          </select>
        </Field>
        <p className="help m-0">Direct write replaces the library file only after the new file passes an integrity check. Waiting bulk jobs pick this up when they start. Queue new Arr imports still writes a sidecar. Arr refresh failures stay as a warning.</p>
        <button
          className="btn"
          type="button"
          onClick={save}
        >
          Save settings
        </button>
      </div>
      <div className="glass space-y-4 p-5">
        <h2 className="font-semibold">Account</h2>
        <p className="help m-0">Change the sign-in name and password. Polisharr signs you in again after a password change.</p>
        <Field label="Username">
          <input className={FIELD_CONTROL} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
        </Field>
        <Field label="New password">
          <input className={FIELD_CONTROL} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </Field>
        <button
          className="btn"
          type="button"
          disabled={!username.trim() || password.length < 8}
          onClick={() => void api.changePassword(username.trim(), password).then(() => {
            setPassword("");
            setMsg("Username and password saved.");
            onChange();
          }).catch((e: Error) => setMsg(e.message))}
        >
          Save username and password
        </button>
      </div>
      <div className="glass space-y-4 p-5">
        <h2 className="font-semibold">Size caps (GB per hour)</h2>
        <p className="help m-0">Automatic Suggestions transcode when the file is above the cap for its kind.</p>
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          {SIZE_CAP_GRID.map((column) => (
            <div key={column.heading} className="space-y-3">
              <h3 className="text-sm font-semibold tracking-wide text-muted">{column.heading}</h3>
              <div className="grid grid-cols-1 gap-3">
                {column.cells.map((cell) => {
                  const preview = (data.profilePreviews ?? []).find((row) => row.category === cell.key);
                  return (
                    <Field key={cell.key} label={cell.row}>
                      <input
                        className={FIELD_CONTROL}
                        type="number"
                        step="0.1"
                        min="0.1"
                        value={data.sizeCaps[cell.key] ?? ""}
                        onChange={(event) => setData({
                          ...data,
                          sizeCaps: { ...data.sizeCaps, [cell.key]: Number(event.target.value) },
                        })}
                      />
                      {preview && (
                        <span className="help m-0">{preview.gbPerHour.toFixed(2)} GB/hr · {preview.mbPerMin.toFixed(1)} MB/min</span>
                      )}
                    </Field>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <SuggestionDefaultsSettings
          value={data.suggestionDefaults}
          videoTarget={data.videoTarget}
          onChange={(suggestionDefaults) => setData({ ...data, suggestionDefaults })}
          onSave={save}
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={data.profileAutoAssign}
            onChange={(event) => setData({ ...data, profileAutoAssign: event.target.checked })}
          />
          Assign a Polisharr profile after an eligible video transcode
        </label>
        <button className="btn" type="button" onClick={() => void api.syncProfiles().then((r) => setMsg(r.results.map((x) => `${x.created.length} created, ${x.updated.length} updated`).join(" · ") || "Profiles synced.")).catch((e: Error) => setMsg(e.message))}>
          Sync quality profiles
        </button>
        <p className="help">Sync creates or repairs Polisharr-named profiles without changing other profiles or global quality-size limits. Auto-assign applies only after a video transcode and never starts a search. Sonarr assigns the profile to the whole series.</p>
      </div>
      <EncodeSettings
        data={data}
        hardwareLabel={hw ? `${hw.backend}${hw.av1 ? ", AV1 encoder listed" : ", AV1 encoder not listed"}` : "checking…"}
        av1Available={Boolean(nodes.some((node) => node.online && node.enabled && node.hardware.av1) || hw?.av1)}
        onChange={(patch) => setData({ ...data, ...patch })}
        onSave={save}
      />
      <div className="glass space-y-4 p-5">
        <h2 className="font-semibold">Nodes</h2>
        <p className="help m-0">
          This container is one encode node: a GPU box that can run optimize jobs. Settings, the library, Review, and Keep stay here. On the always-on host set POLISHARR_ROLE=master so another GPU box can join. Generate a cluster token, then set that token on the worker. The token is shown once.
        </p>
        {nodes.length > 1 && (
          <Field label="Default encode node">
            <select
              className={FIELD_CONTROL}
              value={data.defaultEncodeNodeId ?? data.thisNodeId ?? ""}
              onChange={(event) => {
                const next = { ...data, defaultEncodeNodeId: event.target.value };
                setData(next);
                void api.saveSettings(next).then(() => {
                  setMsg("Default encode node saved. Jobs already in Queue keep the node they were given.");
                  onChange();
                }).catch((error: Error) => setMsg(error.message));
              }}
            >
              {nodes.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.name}{node.online ? "" : " (offline)"}
                </option>
              ))}
            </select>
          </Field>
        )}
        {nodes.length > 1 && (
          <p className="help m-0">
            New jobs run on the default encode node. If that node is offline, the job waits; it does not move to another GPU.
          </p>
        )}
        <ul className="space-y-3 text-sm">
          {nodes.map((node) => (
            <li key={node.id} className="space-y-2 rounded-lg border border-gray-200 bg-white px-3 py-3 dark:border-gray-800 dark:bg-white/[0.03]">
              <div className="font-medium text-ink">{node.name}</div>
              <div className="text-muted">{node.roleLabel} · {node.hardwareLabel} · {node.online ? "Online" : "Offline"}{node.enabled ? "" : " · Drained"}</div>
              <div className="flex flex-wrap items-end gap-3">
                <label className="block text-sm">
                  <span className="mb-1 block font-medium text-muted">Concurrent jobs</span>
                  <input
                    className="h-10 w-24"
                    type="number"
                    min={1}
                    max={16}
                    value={node.concurrency}
                    onChange={(event) => {
                      const concurrency = Number(event.target.value);
                      void api.saveNode(node.id, { concurrency }).then((result) => {
                        setNodes((current) => current.map((row) => row.id === node.id ? result.node : row));
                        setMsg("Node slots saved.");
                      }).catch((error: Error) => setMsg(error.message));
                    }}
                  />
                </label>
                <button
                  className="btn-secondary h-10"
                  type="button"
                  onClick={() => {
                    void api.saveNode(node.id, { enabled: !node.enabled }).then((result) => {
                      setNodes((current) => current.map((row) => row.id === node.id ? result.node : row));
                      setMsg(result.node.enabled ? `${node.name} can take new jobs.` : `${node.name} is drained. Waiting jobs stay assigned.`);
                    }).catch((error: Error) => setMsg(error.message));
                  }}
                >
                  {node.enabled ? "Drain" : "Enable"}
                </button>
              </div>
            </li>
          ))}
        </ul>
        {clusterToken ? (
          <SecretOnce
            label="Cluster token (shown once)"
            value={clusterToken}
            onCopied={() => setMsg("Cluster token copied.")}
            onFailed={() => setMsg("Copy failed. Select the token and copy it yourself.")}
          />
        ) : (
          <p className="help">{data.hasClusterToken ? "A cluster token is saved. Generate a new one to replace it." : "No cluster token yet. Generate one before you add another GPU box."}</p>
        )}
        <button
          className="btn"
          type="button"
          onClick={() =>
            void api.mintClusterToken().then((result) => {
              setClusterToken(result.token);
              load();
              setMsg("Cluster token generated. Copy it now; Polisharr will not show it again.");
            }).catch((e: Error) => setMsg(e.message))
          }
        >
          {data.hasClusterToken ? "Rotate cluster token" : "Generate cluster token"}
        </button>
      </div>
      <div className="glass space-y-4 p-5">
        <h2 className="font-semibold">Suggestion exclusions</h2>
        <p className="help m-0">An exclusion hides matching files from Suggestions. It does not delete files or cancel queued work.</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[12rem_1fr_auto] sm:items-end">
          <Field label="Kind">
            <select className={FIELD_CONTROL} value={exclusion.kind} onChange={(event) => {
              const kind = event.target.value;
              if (kind === "path" || kind === "profile" || kind === "tag" || kind === "title") {
                setExclusion({ ...exclusion, kind });
              }
            }}>
              <option value="path">Path starts with</option>
              <option value="profile">Quality profile</option>
              <option value="tag">Tag id</option>
              <option value="title">Title</option>
            </select>
          </Field>
          <Field label="Value">
            <input className={FIELD_CONTROL} value={exclusion.value} onChange={(event) => setExclusion({ ...exclusion, value: event.target.value })} placeholder="Value to exclude" />
          </Field>
          <button className="btn h-10" type="button" disabled={!exclusion.value.trim()} onClick={() => void api.addExclusion(exclusion.kind, exclusion.value).then((result) => {
            setExclusions(result.exclusions);
            setExclusion({ ...exclusion, value: "" });
          }).catch((error: Error) => setMsg(error.message))}>Add exclusion</button>
        </div>
        <ul className="space-y-2 text-sm">
          {exclusions.map((rule) => <li key={rule.id} className="flex items-center justify-between gap-2">
            <span>{rule.kind}: {rule.value}</span>
            <button className="btn-secondary danger" type="button" onClick={() => void api.deleteExclusion(rule.id).then((result) => setExclusions(result.exclusions))}>Remove</button>
          </li>)}
        </ul>
      </div>
      <div className="glass space-y-4 p-5">
        <h2 className="font-semibold">Connections</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Kind">
            <select className={FIELD_CONTROL} value={inst.kind} onChange={(e) => {
              const kind = e.target.value;
              if (kind === "radarr" || kind === "sonarr" || kind === "plex" || kind === "jellyfin") {
                setInst({ ...inst, kind });
              }
            }}>
              <option value="radarr">Radarr</option>
              <option value="sonarr">Sonarr</option>
              <option value="plex">Plex</option>
              <option value="jellyfin">Jellyfin</option>
            </select>
          </Field>
          <Field label="Name">
            <input className={FIELD_CONTROL} placeholder="Name" value={inst.name} onChange={(e) => setInst({ ...inst, name: e.target.value })} />
          </Field>
          <Field label="URL">
            <input className={FIELD_CONTROL} placeholder="URL" value={inst.url} onChange={(e) => setInst({ ...inst, url: e.target.value })} />
          </Field>
          <Field label="API key or token">
            <input className={FIELD_CONTROL} placeholder="API key or token" value={inst.apiKey} onChange={(e) => setInst({ ...inst, apiKey: e.target.value })} />
          </Field>
        </div>
        <button
          className="btn"
          type="button"
          onClick={() =>
            void api
              .saveInstance(inst)
              .then(async () => {
                setInst({ ...inst, name: "", url: "", apiKey: "" });
                load();
                onChange();
                if (inst.kind === "radarr" || inst.kind === "sonarr") {
                  const result = await api.refresh();
                  setMsg(result.errors.length ? result.errors.join(" ") : `${inst.name} saved. Library lists updated.`);
                }
              })
              .catch((e: Error) => setMsg(e.message))
          }
        >
          Save connection
        </button>
        <ul className="space-y-2 text-sm">
          {data.instances.map((row) => (
            <li key={row.id} className="space-y-2 rounded-lg border border-gray-200 bg-white px-3 py-3 dark:border-gray-800 dark:bg-white/[0.03]">
              <div className="min-w-0">
                <div className="font-medium text-ink">{row.name}</div>
                <div className="truncate text-xs text-muted">
                  {row.kind} · {row.url} · {row.enabled ? "enabled" : "paused"} · {row.hasApiKey || row.hasToken ? "key saved" : "no key"}
                </div>
              </div>
              <span className="flex flex-wrap gap-2">
                <button
                  className="btn-secondary"
                  type="button"
                  onClick={() => void api.saveInstance({
                    id: row.id,
                    kind: row.kind,
                    name: row.name,
                    url: row.url,
                    enabled: !row.enabled,
                  }).then(() => {
                    load();
                    onChange();
                    setMsg(row.enabled ? `${row.name} paused.` : `${row.name} enabled.`);
                  }).catch((e: Error) => setMsg(e.message))}
                >
                  {row.enabled ? "Pause" : "Enable"}
                </button>
                <button className="btn-secondary" type="button" onClick={() => void api.testInstance(row.id).then((r) => setMsg(r.ok ? `${row.name} is reachable.` : r.message || "Test failed."))}>
                  Test
                </button>
                <button className="btn-secondary danger" type="button" onClick={() => void api.deleteInstance(row.id).then(load)}>
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ul>
        <RefreshLibrary />
      </div>
      <div className="glass space-y-4 p-5">
        <h2 className="font-semibold">Radarr and Sonarr webhooks</h2>
        <p className="help">
          Polisharr can learn about a finished download as soon as Radarr or Sonarr imports it, instead of waiting for the next 15-minute sync. The webhook itself does not start an encode. Turn on Queue new Arr imports automatically if you want a matching suggestion queued as a sidecar.
        </p>
        <p className="text-sm">
          URL: <code>{typeof window !== "undefined" ? `${window.location.origin}/api/hooks/arr` : "/api/hooks/arr"}</code>
        </p>
        <p className="help">
          On the Arr Docker network use <code>http://polisharr:7373/api/hooks/arr</code>. In Connect, enable On Import, On Upgrade, and On Rename. Paste the token as header <code>X-Api-Key</code>, or as the Connect password. A query <code>?apikey=</code> works if the form only has a URL; that puts the token in access logs.
        </p>
        {webhookToken ? (
          <SecretOnce
            label="Token (shown once)"
            value={webhookToken}
            onCopied={() => setMsg("Webhook token copied.")}
            onFailed={() => setMsg("Copy failed. Select the token and copy it yourself.")}
          />
        ) : (
          <p className="help">{data.hasWebhookToken ? "A token is saved. Generate a new one to replace it." : "No token yet. Generate one before you add the Connect webhook."}</p>
        )}
        <button
          className="btn"
          type="button"
          onClick={() =>
            void api.mintWebhookToken().then((result) => {
              setWebhookToken(result.token);
              load();
              setMsg("Webhook token generated. Copy it now; Polisharr will not show it again.");
            }).catch((e: Error) => setMsg(e.message))
          }
        >
          {data.hasWebhookToken ? "Rotate webhook token" : "Generate webhook token"}
        </button>
      </div>
      <div className="glass space-y-4 p-5">
        <h2 className="font-semibold">Homepage widget</h2>
        <p className="help">
          Homepage can poll Polisharr for running title, queued, review, suggestions, and errors. The key is shown once.
        </p>
        {widgetKey ? (
          <SecretOnce
            label="Key (shown once)"
            value={widgetKey}
            onCopied={() => setMsg("Widget key copied.")}
            onFailed={() => setMsg("Copy failed. Select the key and copy it yourself.")}
          />
        ) : (
          <p className="help">{data.hasWidgetKey ? "A widget key is saved. Generate a new one to replace it." : "No widget key yet. Generate one before you add the Homepage tile."}</p>
        )}
        <button
          className="btn"
          type="button"
          onClick={() =>
            void api.mintWidgetKey().then((result) => {
              setWidgetKey(result.key);
              load();
              setMsg("Widget key generated. Copy it now; Polisharr will not show it again.");
            }).catch((e: Error) => setMsg(e.message))
          }
        >
          {data.hasWidgetKey ? "Rotate widget key" : "Generate widget key"}
        </button>
      </div>
      {msg && <p className="ok text-sm">{msg}</p>}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5 text-sm">
      <span className="font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}

function SecretOnce({
  label,
  value,
  onCopied,
  onFailed,
}: {
  label: string;
  value: string;
  onCopied: () => void;
  onFailed: () => void;
}) {
  return (
    <div className="space-y-1.5 text-sm">
      <div className="font-medium text-muted">{label}</div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <code className="min-w-0 flex-1 break-all rounded-md border border-ink/15 bg-canvas px-3 py-2 text-xs text-ink">{value}</code>
        <button
          className="btn-secondary h-10 shrink-0"
          type="button"
          onClick={() => void navigator.clipboard.writeText(value).then(onCopied).catch(onFailed)}
        >
          Copy
        </button>
      </div>
    </div>
  );
}
