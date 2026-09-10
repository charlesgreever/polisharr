import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { api, formatSize, type ClusterNode, type ExecutablePlan, type InspectionReport, type LibraryRow } from "../api";
import { Help, PageHead } from "../components/Shell";
import { EncodeNodeSelect } from "../components/EncodeNodeSelect";
import { EncodeTargetSelect } from "../components/EncodeTargetSelect";
import { TitleFacts } from "../components/TitleFacts";
import { Pill } from "../components/ui";
import {
  audioActionSelectClass,
  audioChannelSelectClass,
  canIdentifyLanguage,
  canIdentifySubtitle,
  canQueueCustomPlan,
  isImageSubtitle,
  isUntaggedTrack,
  MISSING_WHISPER_LID,
  untaggedAudioNeedsLanguageIdHint,
  formatClipClock,
  parseClipClock,
  titleOptimizeLocked,
} from "../title-plan";
import { channelLabel, fileNameFromPath, usefulTrackTitle } from "../title-display";

type AudioAction = "keep" | "remove" | "replace_aac" | "replace_downmix" | "add_downmix";

export function TitlePage() {
  const { id = "" } = useParams();
  const [item, setItem] = useState<LibraryRow | null>(null);
  const [av1, setAv1] = useState(false);
  const [nodes, setNodes] = useState<ClusterNode[]>([]);
  const [defaultNodeId, setDefaultNodeId] = useState("");
  const [encodeNodeId, setEncodeNodeId] = useState("");
  const [writeDefault, setWriteDefault] = useState("sidecar");
  const [houseVideoTarget, setHouseVideoTarget] = useState<"hevc" | "av1">("hevc");
  const [preferredLanguage, setPreferredLanguage] = useState("eng");
  const [msg, setMsg] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [plan, setPlan] = useState<ExecutablePlan | null>(null);
  const [videoMode, setVideoMode] = useState<"copy" | "size" | "quality">("copy");
  const [targetGb, setTargetGb] = useState(4);
  const [quality, setQuality] = useState(22);
  const [codec, setCodec] = useState<"hevc" | "av1">("hevc");
  const [downscale, setDownscale] = useState(false);
  const [writeMode, setWriteMode] = useState<"default" | "sidecar" | "direct">("default");
  const [audio, setAudio] = useState<Record<number, { action: AudioAction; channels?: number }>>({});
  const [subs, setSubs] = useState<Record<number, "keep" | "remove">>({});
  const [languageIdAvailable, setLanguageIdAvailable] = useState(false);
  const [pgsOcrAvailable, setPgsOcrAvailable] = useState(false);
  const [lid, setLid] = useState<{
    trackIndex: number;
    listening: boolean;
    ok: boolean | null;
    language?: string;
    languageName?: string;
    probability?: number;
    startSec?: number;
    suggestedNextSec?: number;
    reason?: string;
    timeInput: string;
  } | null>(null);
  const [subLid, setSubLid] = useState<{
    trackIndex: number;
    listening: boolean;
    ok: boolean | null;
    language?: string;
    languageName?: string;
    probability?: number;
    startSec?: number;
    suggestedNextSec?: number;
    reason?: string;
    timeInput: string;
  } | null>(null);

  const report = item?.report as InspectionReport | null | undefined;
  const is4k = (item?.resolution === "2160") || (report?.height ?? 0) >= 2160 || (report?.width ?? 0) >= 3840;
  const iso = (item?.path ?? "").toLowerCase().endsWith(".iso");
  const listed = report?.listingState === "complete";
  const fileName = fileNameFromPath(item?.path ?? "");

  useEffect(() => {
    void api.title(id).then((r) => {
      setItem(r.item);
      setAv1(Boolean(r.av1Available ?? r.hardware.av1));
      setWriteDefault(r.settings.writeMode);
      setHouseVideoTarget(r.settings.videoTarget === "av1" ? "av1" : "hevc");
      if (r.settings.preferredLanguage) setPreferredLanguage(r.settings.preferredLanguage);
      setLanguageIdAvailable(Boolean(r.languageId?.available));
      setPgsOcrAvailable(Boolean(r.pgsOcr?.available));
      const nextAudio: Record<number, { action: AudioAction; channels?: number }> = {};
      const nextSubs: Record<number, "keep" | "remove"> = {};
      for (const t of r.item.report?.audio ?? []) nextAudio[t.index] = { action: "keep" };
      for (const t of r.item.report?.subtitles ?? []) nextSubs[t.index] = "keep";
      setAudio(nextAudio);
      setSubs(nextSubs);
    }).catch((e: Error) => setMsg(e.message));
    void api.nodes().then((payload) => {
      setNodes(payload.nodes);
      setDefaultNodeId(payload.defaultEncodeNodeId);
      setEncodeNodeId((current) => current || payload.defaultEncodeNodeId);
    }).catch(() => undefined);
  }, [id]);

  const draft = useMemo(() => ({
    remuxToMkv: iso,
    video: videoMode === "copy"
      ? { mode: "copy" }
      : videoMode === "size"
        ? { mode: "size", targetBytes: Math.round(targetGb * 1024 ** 3), codec, downscale1080p: downscale }
        : { mode: "quality", quality, codec, downscale1080p: downscale },
    audio: Object.entries(audio).map(([index, choice]) => ({ index: Number(index), ...choice })),
    subtitles: Object.entries(subs).map(([index, action]) => ({ index: Number(index), action })),
    writeMode,
  }), [iso, videoMode, targetGb, quality, codec, downscale, audio, subs, writeMode]);

  useEffect(() => {
    if (!item) return;
    const t = setTimeout(() => {
      void api.previewPlan(id, draft).then((r) => {
        setPlan(r.plan ?? null);
        setErrors((r.errors ?? []).map((e) => e.message).concat(r.error ? [r.error] : []));
      });
    }, 200);
    return () => clearTimeout(t);
  }, [draft, id, item]);

  async function listenForLanguage(trackIndex: number, startSec?: number) {
    setLid({
      trackIndex,
      listening: true,
      ok: null,
      timeInput: formatClipClock(startSec ?? 90),
    });
    try {
      const result = await api.detectLanguage(id, trackIndex, startSec);
      if (result.ok && result.language) {
        setLid({
          trackIndex,
          listening: false,
          ok: true,
          language: result.language,
          languageName: result.languageName,
          probability: result.probability,
          startSec: result.startSec,
          suggestedNextSec: result.suggestedNextSec,
          timeInput: formatClipClock(result.suggestedNextSec ?? (result.startSec ?? 0) + 600),
        });
        return;
      }
      setLid({
        trackIndex,
        listening: false,
        ok: false,
        reason: result.reason,
        startSec: result.startSec,
        suggestedNextSec: result.suggestedNextSec,
        timeInput: formatClipClock(result.suggestedNextSec ?? 600),
      });
    } catch (error) {
      setLid({
        trackIndex,
        listening: false,
        ok: false,
        reason: error instanceof Error ? error.message : "Language identification failed.",
        startSec: startSec ?? 90,
        timeInput: formatClipClock(startSec ?? 90),
      });
    }
  }

  async function useDetectedLanguage(trackIndex: number) {
    if (!lid?.language || lid.probability == null) return;
    try {
      const result = await api.applyLanguage(id, trackIndex, lid.language, lid.probability);
      if (result.item) setItem(result.item);
      setLid(null);
      setMsg(`Saved ${result.languageName ?? lid.languageName} on this soundtrack.`);
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "Could not save that language.");
    }
  }

  async function listenForSubtitleLanguage(trackIndex: number, startSec?: number) {
    setSubLid({
      trackIndex,
      listening: true,
      ok: null,
      timeInput: formatClipClock(startSec ?? 90),
    });
    try {
      const result = await api.detectSubtitleLanguage(id, trackIndex, startSec);
      if (result.ok && result.language) {
        setSubLid({
          trackIndex,
          listening: false,
          ok: true,
          language: result.language,
          languageName: result.languageName,
          probability: result.probability,
          startSec: result.startSec,
          suggestedNextSec: result.suggestedNextSec,
          timeInput: formatClipClock(result.suggestedNextSec ?? (result.startSec ?? 0) + 600),
        });
        return;
      }
      setSubLid({
        trackIndex,
        listening: false,
        ok: false,
        reason: result.reason,
        startSec: result.startSec,
        suggestedNextSec: result.suggestedNextSec,
        timeInput: formatClipClock(result.suggestedNextSec ?? 600),
      });
    } catch (error) {
      setSubLid({
        trackIndex,
        listening: false,
        ok: false,
        reason: error instanceof Error ? error.message : "Language identification failed.",
        timeInput: formatClipClock(startSec ?? 90),
      });
    }
  }

  async function useDetectedSubtitleLanguage(trackIndex: number) {
    if (!subLid?.language || subLid.probability == null) return;
    try {
      const result = await api.applySubtitleLanguage(id, trackIndex, subLid.language, subLid.probability);
      if (result.item) setItem(result.item);
      setSubLid(null);
      setMsg(`Saved ${result.languageName ?? subLid.languageName} on this subtitle track.`);
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "Could not save that language.");
    }
  }

  if (!item) return <p className="help">{msg || "Loading title…"}</p>;

  const locked = titleOptimizeLocked(item);
  const queueReady = canQueueCustomPlan(plan, errors, locked);
  const usableAudio = (report?.audio ?? []).filter((track) => track.channels > 0);
  const onlyWrongLanguage = usableAudio.length === 1
    && (usableAudio[0]?.language ?? "und") !== "und"
    && (usableAudio[0]?.language ?? "und") !== preferredLanguage
    && !locked;
  const arrName = item.type === "episode" ? "Sonarr" : "Radarr";

  return (
    <section className="space-y-5">
      <PageHead title={item.displayTitle}>
        <Link className="btn-secondary" to={item.type === "movie" ? "/movies" : "/series"}>Back</Link>
      </PageHead>
      <Help>
        Custom work is optional. Bulk suggestions still exist. Queue stays off until the plan differs from the source.
        A sidecar is the new file waiting in Review until you Keep it. Direct write replaces the library file after an integrity check.
        Codec replace turns one soundtrack into AAC at the same layout. Downmix makes a smaller layout such as stereo.
        Size mode aims at a file size you type. Quality mode aims at an encoder quality number (lower is larger).
        Identify language listens to a 45-second audio clip, or reads a few minutes of a text subtitle track. Untagged PGS can be identified from a short OCR sample when that helper is installed. Saving a language does not rewrite the library file. Queue this plan can remux a copy that writes the tag; Keep then replaces the library file.
      </Help>
      {(locked || item.error) && (
        <p className="help">{item.error || "This title is still uninspected or unreadable. Optimize stays off until inspect finishes."}</p>
      )}
      {iso && !listed && !item.error && (
        <p className="help">Streams could not be listed yet. You can still remux this disc image to Matroska, or pick a size or quality encode.</p>
      )}
      <TitleFacts item={item} />
      {item.type === "movie" && (
        <div className="glass max-w-xs p-4">
          <EncodeTargetSelect
            value={item.videoTarget ?? null}
            houseTarget={houseVideoTarget}
            av1Available={av1}
            onChange={(videoTarget) => {
              void api.setItemVideoTarget(item.id, videoTarget).then((result) => {
                setItem(result.item);
                setMsg("Encode target saved.");
              }).catch((error: Error) => setMsg(error.message));
            }}
          />
          <p className="help m-0 mt-2">Automatic Suggestions for this movie use this codec. House default follows Settings. The custom plan Codec below is only for one queued job.</p>
        </div>
      )}

      {item.suggestion && (
        <Section title="Automatic suggestion">
          <ul className="space-y-1 text-sm leading-5 text-muted">
            {item.suggestion.reasons.map((reason) => <li key={reason}>{reason}</li>)}
          </ul>
          <div className="mt-3 max-w-xs">
            <EncodeNodeSelect
              nodes={nodes}
              value={encodeNodeId}
              defaultNodeId={defaultNodeId}
              need={!item.suggestion.actions.includes("transcode")
                ? "copy"
                : (item.videoTarget ?? houseVideoTarget) === "av1" && av1 ? "av1" : "hevc"}
              disabled={locked}
              onChange={setEncodeNodeId}
            />
          </div>
          <button
            className="btn mt-1"
            type="button"
            disabled={locked || item.suggestion.actions.every((action) => action === "search_language" || action === "search_release")}
            onClick={() => void api.queue({ itemId: item.id, assignedNodeId: encodeNodeId || undefined }).then(() => setMsg("Bulk plan queued.")).catch((e: Error) => setMsg(e.message))}
          >
            Queue suggested work
          </button>
        </Section>
      )}
      <div className="grid gap-5 lg:grid-cols-2">
        <Section title="Video">
          <fieldset disabled={locked} className="space-y-3 border-0 p-0">
          <div className="grid gap-2 sm:grid-cols-3">
            <ModeChoice name="video-mode" checked={videoMode === "copy"} onChange={() => setVideoMode("copy")} label="Copy / remux" />
            <ModeChoice name="video-mode" checked={videoMode === "size"} onChange={() => setVideoMode("size")} label="Target file size" />
            <ModeChoice name="video-mode" checked={videoMode === "quality"} onChange={() => setVideoMode("quality")} label="Encoder quality" />
          </div>
          {videoMode === "size" && (
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-muted">Target GB</span>
              <input className="w-28" type="number" min={0.1} step={0.1} value={targetGb} onChange={(e) => setTargetGb(Number(e.target.value))} />
            </label>
          )}
          {videoMode === "quality" && (
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-muted">Quality 1–51</span>
              <input className="w-28" type="number" min={1} max={51} value={quality} onChange={(e) => setQuality(Number(e.target.value))} />
            </label>
          )}
          {videoMode !== "copy" && (
            <div className="space-y-3">
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-muted">Codec</span>
                <select value={av1 ? codec : "hevc"} onChange={(e) => {
                  const value = e.target.value;
                  if (value === "hevc" || (value === "av1" && av1)) setCodec(value);
                }}>
                  <option value="hevc">HEVC</option>
                  {av1 && <option value="av1">AV1</option>}
                </select>
              </label>
              {is4k && (
                <label className="flex items-center gap-2 text-sm">
                  <input className="accent-accent" type="checkbox" checked={downscale} onChange={(e) => setDownscale(e.target.checked)} />
                  Downscale 4K to 1080p
                </label>
              )}
            </div>
          )}
          </fieldset>
        </Section>
        <Section title="Write mode" help={`House default is ${writeDefault}. Direct write replaces the library file after an integrity check.`}>
          <select value={writeMode} disabled={locked} onChange={(e) => {
            const value = e.target.value;
            if (value === "default" || value === "sidecar" || value === "direct") setWriteMode(value);
          }}>
            <option value="default">Use house default</option>
            <option value="sidecar">Sidecar for Review</option>
            <option value="direct">Direct write</option>
          </select>
        </Section>
      </div>
      <Section title="Audio">
        <fieldset disabled={locked} className="space-y-2 border-0 p-0">
        {!listed && <p className="help m-0">Track edits stay hidden until streams can be listed.</p>}
        {listed && (
          <div className="space-y-2">
            {report?.audio.map((track) => {
              const title = usefulTrackTitle(track.title, fileName);
              return (
                <div key={track.index} className="flex flex-col gap-3 rounded-lg border border-gray-200 bg-white px-3 py-2 sm:flex-row sm:items-center sm:justify-between dark:border-gray-800 dark:bg-white/[0.03]">
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <Pill>{track.language || "und"}</Pill>
                    <Pill>{track.codec}</Pill>
                    <Pill>{channelLabel(track.channels)}</Pill>
                    {title && <span className="max-w-64 truncate text-xs text-muted">{title}</span>}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <select
                      className={audioActionSelectClass}
                      value={audio[track.index]?.action ?? "keep"}
                      onChange={(e) => setAudio({
                        ...audio,
                        [track.index]: { action: parseAudioAction(e.target.value), channels: audio[track.index]?.channels ?? 2 },
                      })}
                    >
                      <option value="keep">Keep</option>
                      <option value="remove">Remove</option>
                      <option value="replace_aac">Replace with AAC</option>
                      {track.channels > 2 && <option value="replace_downmix">Replace with downmix</option>}
                      {track.channels > 2 && <option value="add_downmix">Add downmix</option>}
                    </select>
                    {(audio[track.index]?.action === "replace_downmix" || audio[track.index]?.action === "add_downmix") && (
                      <select
                        className={audioChannelSelectClass}
                        value={audio[track.index]?.channels ?? 2}
                        onChange={(e) => setAudio({
                          ...audio,
                          [track.index]: { ...audio[track.index], action: audio[track.index]?.action ?? "add_downmix", channels: Number(e.target.value) },
                        })}
                      >
                        {track.channels > 6 && <option value={6}>5.1</option>}
                        <option value={2}>stereo</option>
                      </select>
                    )}
                    {canIdentifyLanguage(track, languageIdAvailable, locked) && (
                      <button
                        className="btn-secondary"
                        type="button"
                        disabled={lid?.listening === true}
                        onClick={() => void listenForLanguage(track.index, lid?.trackIndex === track.index ? parseClipClock(lid.timeInput) ?? lid.suggestedNextSec : undefined)}
                      >
                        {lid?.listening && lid.trackIndex === track.index ? "Listening…" : "Identify language"}
                      </button>
                    )}
                  </div>
                  {untaggedAudioNeedsLanguageIdHint(track, languageIdAvailable, locked) && (
                    <p className="help m-0 w-full basis-full">{MISSING_WHISPER_LID}</p>
                  )}
                  {lid && lid.trackIndex === track.index && !lid.listening && (
                    <div className="w-full basis-full space-y-2 text-sm text-muted">
                      {lid.ok && lid.languageName && (
                        <p className="m-0">This clip sounds like {lid.languageName} ({Math.round((lid.probability ?? 0) * 100)}%).</p>
                      )}
                      {lid.ok === false && (
                        <p className="m-0">{lid.reason ?? "No speech in this sample."} Started at {formatClipClock(lid.startSec ?? 0)}.</p>
                      )}
                      {lid.ok === false && (
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            className="h-10 w-24 rounded-md border border-gray-200 bg-white px-2 dark:border-gray-800 dark:bg-white/[0.03]"
                            value={lid.timeInput}
                            onChange={(e) => setLid({ ...lid, timeInput: e.target.value })}
                            aria-label="Start time"
                          />
                          {([30, 600, Math.floor((report?.durationSec ?? 0) / 2), Math.floor((report?.durationSec ?? 0) * 2 / 3)] as const).map((sec) => (
                            <button
                              key={sec}
                              className="btn-secondary"
                              type="button"
                              onClick={() => setLid({ ...lid, timeInput: formatClipClock(sec) })}
                            >
                              {formatClipClock(sec)}
                            </button>
                          ))}
                          <button className="btn-secondary" type="button" onClick={() => void listenForLanguage(track.index, parseClipClock(lid.timeInput) ?? lid.suggestedNextSec)}>
                            Listen again
                          </button>
                        </div>
                      )}
                      {lid.ok && lid.language && (
                        <div className="flex flex-wrap gap-2">
                          <button className="btn" type="button" onClick={() => void useDetectedLanguage(track.index)}>
                            {`Use ${lid.languageName}`}
                          </button>
                          <button className="btn-secondary" type="button" onClick={() => setLid({ ...lid, ok: false, reason: "Try another time in the file.", timeInput: formatClipClock(lid.suggestedNextSec ?? (lid.startSec ?? 0) + 600) })}>
                            Try another time
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        </fieldset>
      </Section>
      <Section title="Subtitles">
        {listed && report?.subtitles.length ? (
          <div className="space-y-2">
            {report.subtitles.map((track) => {
              const title = usefulTrackTitle(track.title, fileName);
              const kept = (subs[track.index] ?? "keep") === "keep";
              return (
                <div key={track.index} className="flex flex-col gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 dark:border-gray-800 dark:bg-white/[0.03]">
                <label className="flex cursor-pointer flex-wrap items-center gap-3 text-sm">
                  <input
                    className="accent-accent"
                    type="checkbox"
                    checked={kept}
                    onChange={(e) => setSubs({ ...subs, [track.index]: e.target.checked ? "keep" : "remove" })}
                  />
                  <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <Pill>{track.language || "und"}</Pill>
                    <Pill>{track.codec}</Pill>
                    {track.sdh && <Pill tone="accent">SDH</Pill>}
                    {track.forced && <Pill>forced</Pill>}
                    {title && <span className="max-w-64 truncate text-xs text-muted">{title}</span>}
                  </span>
                  {canIdentifySubtitle(track, locked, pgsOcrAvailable) && (
                    <button
                      className="btn-secondary ml-auto"
                      type="button"
                      disabled={subLid?.listening === true}
                      onClick={() => void listenForSubtitleLanguage(track.index, subLid?.trackIndex === track.index ? parseClipClock(subLid.timeInput) ?? subLid.suggestedNextSec : undefined)}
                    >
                      {subLid?.listening && subLid.trackIndex === track.index ? "Reading…" : "Identify language"}
                    </button>
                  )}
                </label>
                {isImageSubtitle(track.codec) && isUntaggedTrack(track) && !canIdentifySubtitle(track, locked, pgsOcrAvailable) && (
                  <p className="help m-0">This subtitle track is images, not text, so Polisharr cannot read a sample.</p>
                )}
                {subLid && subLid.trackIndex === track.index && !subLid.listening && (
                  <div className="space-y-2 text-sm text-muted">
                    {subLid.ok && subLid.languageName && (
                      <p className="m-0">This sample looks like {subLid.languageName} ({Math.round((subLid.probability ?? 0) * 100)}%).</p>
                    )}
                    {subLid.ok === false && (
                      <p className="m-0">{subLid.reason ?? "Not enough subtitle text in this sample."} Started at {formatClipClock(subLid.startSec ?? 0)}.</p>
                    )}
                    {subLid.ok === false && (
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          className="h-10 w-24 rounded-md border border-gray-200 bg-white px-2 dark:border-gray-800 dark:bg-white/[0.03]"
                          value={subLid.timeInput}
                          onChange={(e) => setSubLid({ ...subLid, timeInput: e.target.value })}
                          aria-label="Subtitle sample start time"
                        />
                        <button className="btn-secondary" type="button" onClick={() => void listenForSubtitleLanguage(track.index, parseClipClock(subLid.timeInput) ?? subLid.suggestedNextSec)}>
                          Read again
                        </button>
                      </div>
                    )}
                    {subLid.ok && subLid.language && (
                      <div className="flex flex-wrap gap-2">
                        <button className="btn" type="button" onClick={() => void useDetectedSubtitleLanguage(track.index)}>
                          {`Use ${subLid.languageName}`}
                        </button>
                        <button className="btn-secondary" type="button" onClick={() => setSubLid({ ...subLid, ok: false, reason: "Try another time in the file.", timeInput: formatClipClock(subLid.suggestedNextSec ?? (subLid.startSec ?? 0) + 600) })}>
                          Try another time
                        </button>
                      </div>
                    )}
                  </div>
                )}
                </div>
              );
            })}
          </div>
        ) : listed ? (
          <p className="help m-0">No subtitle tracks.</p>
        ) : (
          <p className="help m-0">Track edits stay hidden until streams can be listed.</p>
        )}
      </Section>
      <Section title="Plan details">
        {plan?.estimatedOutputBytes != null && (
          <p className="text-sm">Estimated output: <span className="font-medium tabular-nums">{formatSize(plan.estimatedOutputBytes)}</span></p>
        )}
        {plan?.warning && <p className="text-sm text-warn">{plan.warning}</p>}
        {(plan?.reasons ?? []).length > 0 && (
          <ul className="space-y-1 text-sm leading-5 text-muted">
            {(plan?.reasons ?? []).map((reason) => <li key={reason}>{reason}</li>)}
          </ul>
        )}
        {errors.map((error) => (
          <p key={error} className="rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-sm text-bad">{error}</p>
        ))}
        <div className="mb-3 max-w-xs">
          <EncodeNodeSelect
            nodes={nodes}
            value={encodeNodeId}
            defaultNodeId={defaultNodeId}
            need={videoMode === "copy" ? "copy" : codec === "av1" ? "av1" : "hevc"}
            disabled={locked}
            onChange={setEncodeNodeId}
          />
        </div>
        <button
          className="btn"
          type="button"
          disabled={!queueReady}
          onClick={() => void api.queueCustom(id, draft, false, encodeNodeId || undefined).then(() => setMsg("Custom plan queued.")).catch((e: Error) => setMsg(e.message))}
        >
          Queue this plan
        </button>
        {onlyWrongLanguage && (
          <button
            className="btn-secondary"
            type="button"
            onClick={() => {
              if (!window.confirm(`This removes the current file from the library and asks ${arrName} to search again.`)) return;
              void api.searchPreferred(id)
                .then(() => setMsg(`${arrName} will search for a preferred-language copy.`))
                .catch((e: Error) => setMsg(e.message));
            }}
          >
            {`Ask ${arrName} to search for a preferred-language copy`}
          </button>
        )}
        {(report?.doviProfile === 5 || (report?.hdr === "dolby_vision" && report?.doviCompatId === 0)) && (
          <button
            className="btn-secondary"
            type="button"
            onClick={() => {
              if (!window.confirm(`This is Dolby Vision Profile 5. ${arrName} will remove the current file and search for an HDR10 or Dolby Vision Profile 8 release.`)) return;
              void api.searchPreferred(id)
                .then(() => setMsg(`${arrName} will search for a different release.`))
                .catch((e: Error) => setMsg(e.message));
            }}
          >
            {`Ask ${arrName} to search for a different release`}
          </button>
        )}
      </Section>
      {msg && <p className="ok text-sm">{msg}</p>}
    </section>
  );
}

function Section({ title, help, children }: { title: string; help?: string; children: ReactNode }) {
  return (
    <section className="glass space-y-3 p-5">
      <h2 className="text-sm font-semibold tracking-wide text-ink">{title}</h2>
      {help && <p className="help m-0">{help}</p>}
      {children}
    </section>
  );
}

function parseAudioAction(value: string): AudioAction {
  if (value === "keep" || value === "remove" || value === "replace_aac" || value === "replace_downmix" || value === "add_downmix") {
    return value;
  }
  return "keep";
}

function ModeChoice({ name, checked, onChange, label }: { name: string; checked: boolean; onChange: () => void; label: string }) {
  return (
    <label className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
      checked ? "border-brand-200 bg-brand-50 text-brand-500 dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-brand-400" : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-800 dark:bg-white/[0.03] dark:text-gray-300"
    }`}>
      <input className="accent-accent" type="radio" name={name} checked={checked} onChange={onChange} />
      {label}
    </label>
  );
}
