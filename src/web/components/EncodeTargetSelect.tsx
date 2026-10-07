import { FIELD_CONTROL } from "../settings-copy";
import { Tip } from "./ui";

export function EncodeTargetSelect({
  value,
  houseTarget,
  av1Available,
  disabled,
  tip,
  showLabel = true,
  onChange,
}: {
  value: "hevc" | "av1" | null;
  houseTarget: "hevc" | "av1";
  av1Available: boolean;
  disabled?: boolean;
  tip?: string;
  showLabel?: boolean;
  onChange: (value: "hevc" | "av1" | null) => void;
}) {
  const houseLabel = houseTarget === "av1" && av1Available ? "AV1" : "HEVC";
  return (
    <label className="block min-w-[10rem] text-sm">
      {showLabel ? (
        <span className="mb-1 flex items-center gap-1 font-medium text-muted">
          Encode target
          {tip ? <Tip label="Encode target">{tip}</Tip> : null}
        </span>
      ) : null}
      <select
        className={FIELD_CONTROL}
        value={value ?? ""}
        disabled={disabled}
        aria-label="Encode target"
        onChange={(event) => {
          const next = event.target.value;
          if (next === "hevc" || next === "av1") onChange(next);
          else onChange(null);
        }}
      >
        <option value="">House default ({houseLabel})</option>
        <option value="hevc">HEVC</option>
        {(av1Available || value === "av1") && <option value="av1">AV1</option>}
      </select>
    </label>
  );
}
