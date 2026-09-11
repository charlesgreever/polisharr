import type { SettingsPayload } from "../api";
import { FIELD_CONTROL } from "../settings-copy";

type EncodeSettingsData = Pick<
  SettingsPayload,
  "videoTarget" | "concurrency" | "conservativeMode" | "offPeakEnabled" | "offPeakStart" | "offPeakEnd"
>;

export function EncodeSettings({
  data,
  hardwareLabel,
  av1Available = true,
  onChange,
  onSave,
}: {
  data: EncodeSettingsData;
  hardwareLabel: string;
  av1Available?: boolean;
  onChange: (patch: Partial<EncodeSettingsData>) => void;
  onSave: () => void;
}) {
  return (
    <div className="glass space-y-3 p-4">
      <h2 className="font-semibold">Encode</h2>
      <p className="help">Detected hardware: {hardwareLabel}. Automatic Suggestions that re-encode video use this target. AV1 appears only when encode hardware can encode it.</p>
      <label className="block space-y-1.5 text-sm">
        <span className="font-medium text-muted">Target</span>
        <select className={FIELD_CONTROL} value={av1Available ? data.videoTarget : "hevc"} onChange={(event) => {
          const target = event.target.value;
          if (target === "hevc" || (target === "av1" && av1Available)) onChange({ videoTarget: target });
        }}>
          <option value="hevc">HEVC</option>
          {av1Available && <option value="av1">AV1</option>}
        </select>
      </label>
      <label className="block space-y-1.5 text-sm">
        <span className="font-medium text-muted">Concurrent jobs</span>
        <input
          className="h-10 w-24"
          type="number"
          min={1}
          value={data.concurrency}
          onChange={(event) => onChange({ concurrency: Number(event.target.value) })}
        />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={data.conservativeMode}
          onChange={(event) => onChange({ conservativeMode: event.target.checked })}
        />
        Conservative performance mode (does not change job count)
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={data.offPeakEnabled}
          onChange={(event) => onChange({ offPeakEnabled: event.target.checked })}
        />
        Hold jobs outside off-peak
      </label>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium text-muted">Off-peak start</span>
          <input className={FIELD_CONTROL} value={data.offPeakStart} onChange={(event) => onChange({ offPeakStart: event.target.value })} />
        </label>
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium text-muted">Off-peak end</span>
          <input className={FIELD_CONTROL} value={data.offPeakEnd} onChange={(event) => onChange({ offPeakEnd: event.target.value })} />
        </label>
      </div>
      <button className="btn" type="button" onClick={onSave}>Save encode settings</button>
    </div>
  );
}
