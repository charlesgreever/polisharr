import type { ImportWriteMode, SettingsPayload } from "../api";
import { FIELD_CONTROL, transcodeBelowTargetLabel } from "../settings-copy";

type SuggestionDefaults = SettingsPayload["suggestionDefaults"];

export function SuggestionDefaultsSettings({
  value,
  writeMode,
  onChange,
  onWriteModeChange,
  onSave,
  videoTarget = "hevc",
}: {
  value: SuggestionDefaults;
  writeMode: ImportWriteMode;
  onChange: (value: SuggestionDefaults) => void;
  onWriteModeChange: (mode: ImportWriteMode) => void;
  onSave: () => void;
  videoTarget?: "hevc" | "av1";
}) {
  const checkbox = (field: keyof SuggestionDefaults, label: string) => (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={value[field]}
        onChange={(event) => onChange({ ...value, [field]: event.target.checked })}
      />
      {label}
    </label>
  );

  return (
    <div className="space-y-2 border-t border-gray-200 pt-3 dark:border-gray-800">
      <h3 className="font-semibold">Default suggestion operations</h3>
      {checkbox("removeNonPreferredSubtitles", "Remove non-preferred subtitles")}
      {checkbox("removeNonPreferredAudio", "Remove non-preferred audio tracks")}
      {checkbox("addStereo", "Add stereo from surround audio")}
      {checkbox("transcodeToSizeCap", "Transcode files over their size cap")}
      {checkbox("transcodeBelowHevc", transcodeBelowTargetLabel(videoTarget))}
      {checkbox("convertMp4ToMkv", "Convert MP4 to MKV")}
      {checkbox("convertIsoToMkv", "Convert ISO to MKV")}
      {checkbox("searchPreferredLanguage", "Suggest a Radarr or Sonarr search when the only audio is not preferred")}
      {checkbox("queueNewImports", "Queue new Arr imports automatically")}
      <label className="block space-y-1 pl-6 text-sm">
        <span>How those imports finish</span>
        <select
          className={FIELD_CONTROL}
          value={writeMode}
          disabled={!value.queueNewImports}
          onChange={(event) => {
            const next = event.target.value;
            if (next === "sidecar" || next === "default" || next === "direct") onWriteModeChange(next);
          }}
        >
          <option value="sidecar">Sidecar for Review</option>
          <option value="default">Use Write finished files</option>
          <option value="direct">Direct write</option>
        </select>
      </label>
      <p className="help">These choices control automatic Suggestions. Force, Add stereo, and custom title plans stay available. Transcode video below Target Encode flags H.264, MPEG-2, VC-1, and similar codecs even when the file is under its size cap. When Encode Target is AV1, it also flags HEVC. Encode Target chooses HEVC or AV1 when the GPU can encode AV1. A preferred-language search still waits for a confirm on the title and does not delete a file until you agree. Queue new Arr imports inspects a new or upgraded Radarr or Sonarr file and queues its suggestion. Sidecar for Review waits in Review, and Keep still replaces the library file and does not queue that file again. Use Write finished files follows the Write finished files setting, including a change you save before the job starts. Direct write replaces the library file after the integrity check. Jobs already in Queue keep the choice they were queued with. A later Arr upgrade still can. Turning that on does not queue your existing library.</p>
      <button className="btn" type="button" onClick={onSave}>Save suggestion defaults</button>
    </div>
  );
}
