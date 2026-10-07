import type { ReactNode } from "react";
import type { ImportWriteMode, SettingsPayload } from "../api";
import { FIELD_CONTROL, transcodeBelowTargetLabel } from "../settings-copy";
import { Tip } from "./ui";

type SuggestionDefaults = SettingsPayload["suggestionDefaults"];

export function SuggestionDefaultsSettings({
  value,
  writeMode,
  onChange,
  onWriteModeChange,
  onSave,
  videoTarget = "hevc",
  status = null,
}: {
  value: SuggestionDefaults;
  writeMode: ImportWriteMode;
  onChange: (value: SuggestionDefaults) => void;
  onWriteModeChange: (mode: ImportWriteMode) => void;
  onSave: () => void;
  videoTarget?: "hevc" | "av1";
  status?: ReactNode;
}) {
  const checkbox = (field: keyof SuggestionDefaults, label: string, tip: string) => (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={value[field]}
        onChange={(event) => onChange({ ...value, [field]: event.target.checked })}
      />
      <span>{label}</span>
      <Tip label={label}>{tip}</Tip>
    </label>
  );

  return (
    <div className="space-y-2 border-t border-gray-200 pt-3 dark:border-gray-800">
      <h3 className="font-semibold">Default suggestion operations</h3>
      {checkbox("removeNonPreferredSubtitles", "Remove non-preferred subtitles", "Automatic Suggestions drop subtitle tracks that are not in your preferred language.")}
      {checkbox("removeNonPreferredAudio", "Remove non-preferred audio tracks", "Automatic Suggestions drop audio tracks that are not in your preferred language.")}
      {checkbox("addStereo", "Add stereo from surround audio", "Adds an AAC stereo track to a surround file that has no stereo track in your language, including a 5.1 mix, and keeps the original mix.")}
      {checkbox("transcodeToSizeCap", "Transcode files over their size cap", "Transcodes when the file is above the cap for its kind.")}
      {checkbox("transcodeBelowHevc", transcodeBelowTargetLabel(videoTarget), "Flags H.264, MPEG-2, VC-1, and similar codecs even under the size cap. When the encode target is AV1, it also flags HEVC.")}
      {checkbox("convertMp4ToMkv", "Convert MP4 to MKV", "Offers to remux MP4 files into MKV.")}
      {checkbox("convertIsoToMkv", "Convert ISO to MKV", "Offers to remux disc images into MKV.")}
      {checkbox("searchPreferredLanguage", "Suggest a Radarr or Sonarr search when the only audio is not preferred", "Suggests a search when the only audio is not your language. The search waits for you to confirm and does not delete a file until you agree.")}
      {checkbox("queueNewImports", "Queue new Arr imports automatically", "Inspects a new or upgraded Radarr or Sonarr file and queues its suggestion. Turning that on does not queue your existing library.")}
      <label className="block space-y-1 pl-6 text-sm">
        <span className="flex items-center gap-1">
          How those imports finish
          <Tip label="How those imports finish">Sidecar for Review waits in Review. Keep still replaces the library file. It does not queue that file again. A later Arr upgrade can still queue that file. Use Write finished files follows the Write finished files setting, including a change you save before the job starts. Direct write replaces the library file after the integrity check. Jobs already in Queue keep the choice they were queued with.</Tip>
        </span>
        <select
          className={FIELD_CONTROL}
          value={writeMode}
          disabled={!value.queueNewImports}
          onChange={(event) => {
            const next = event.target.value;
            if (next === "sidecar" || next === "follow" || next === "direct") onWriteModeChange(next);
          }}
        >
          <option value="sidecar">Sidecar for Review</option>
          <option value="follow">Use Write finished files</option>
          <option value="direct">Direct write</option>
        </select>
      </label>
      <button className="btn" type="button" onClick={onSave}>Save suggestion defaults</button>
      {status}
    </div>
  );
}
