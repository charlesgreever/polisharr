import { FIELD_CONTROL } from "../settings-copy";
import { Tip } from "./ui";

export function AudioMixSelect({
  value,
  disabled,
  tip,
  onChange,
}: {
  value: "stereo" | "surround" | null;
  disabled?: boolean;
  tip?: string;
  onChange: (value: "stereo" | "surround" | null) => void;
}) {
  return (
    <label className="block min-w-[11rem] text-sm">
      <span className="mb-1 flex items-center gap-1 font-medium text-muted">
        Preferred audio
        {tip ? <Tip label="Preferred audio">{tip}</Tip> : null}
      </span>
      <select
        className={FIELD_CONTROL}
        value={value ?? ""}
        disabled={disabled}
        aria-label="Preferred audio"
        onChange={(event) => {
          const next = event.target.value;
          if (next === "stereo" || next === "surround") onChange(next);
          else onChange(null);
        }}
      >
        <option value="">House default</option>
        <option value="stereo">Prefer stereo</option>
        <option value="surround">Keep surround</option>
      </select>
    </label>
  );
}
