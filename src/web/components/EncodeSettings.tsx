import type { ReactNode } from "react";
import type { SettingsPayload } from "../api";
import { FIELD_CONTROL } from "../settings-copy";
import { Tip } from "./ui";

type EncodeSettingsData = Pick<
  SettingsPayload,
  "movieVideoTarget" | "tvVideoTarget" | "concurrency" | "conservativeMode" | "offPeakEnabled" | "offPeakStart" | "offPeakEnd"
>;

function TargetField({
  label,
  value,
  av1Available,
  onChange,
}: {
  label: string;
  value: "hevc" | "av1";
  av1Available: boolean;
  onChange: (target: "hevc" | "av1") => void;
}) {
  return (
    <label className="block space-y-1.5 text-sm">
      <span className="font-medium text-muted">{label}</span>
      <select
        className={FIELD_CONTROL}
        aria-label={`${label} encode target`}
        value={av1Available ? value : "hevc"}
        onChange={(event) => {
          const target = event.target.value;
          if (target === "hevc" || (target === "av1" && av1Available)) onChange(target);
        }}
      >
        <option value="hevc">HEVC</option>
        {av1Available && <option value="av1">AV1</option>}
      </select>
    </label>
  );
}

export function EncodeSettings({
  data,
  hardwareLabel,
  av1Available = true,
  onChange,
  onSave,
  status = null,
}: {
  data: EncodeSettingsData;
  hardwareLabel: string;
  av1Available?: boolean;
  onChange: (patch: Partial<EncodeSettingsData>) => void;
  onSave: () => void;
  status?: ReactNode;
}) {
  return (
    <div className="glass space-y-3 p-4">
      <h2 className="flex items-center gap-1 font-semibold">
        Encode
        <Tip label="Encode">Automatic Suggestions that re-encode video use the Movies target or the TV target. A movie or a series can still choose its own codec. AV1 appears only when an encode node can encode it.</Tip>
      </h2>
      <p className="m-0 text-sm text-muted">Detected hardware: {hardwareLabel}.</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TargetField
          label="Movies"
          value={data.movieVideoTarget}
          av1Available={av1Available}
          onChange={(movieVideoTarget) => onChange({ movieVideoTarget })}
        />
        <TargetField
          label="TV"
          value={data.tvVideoTarget}
          av1Available={av1Available}
          onChange={(tvVideoTarget) => onChange({ tvVideoTarget })}
        />
      </div>
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
      {status}
    </div>
  );
}
