import { useId, useState, type ReactNode } from "react";
import { formatSize } from "../api";
import { Icons } from "./icons";

export function Tip({ label, children }: { label: string; children: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span
      className="relative inline-flex align-middle"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="inline-flex size-6 items-center justify-center rounded-full text-accent hover:bg-brand-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent dark:hover:bg-brand-500/10"
        aria-label={`About ${label}`}
        aria-expanded={open}
        aria-describedby={id}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen((current) => !current);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
      >
        {Icons.help({ width: 14, height: 14, "aria-hidden": true })}
      </button>
      <span
        id={id}
        role="tooltip"
        className={open
          ? "absolute left-0 top-7 z-30 w-64 rounded-xl border border-gray-200 bg-white p-3 text-left text-xs font-normal normal-case leading-5 tracking-normal text-gray-700 shadow-theme-sm dark:border-gray-800 dark:bg-gray-900 dark:text-gray-200"
          : "sr-only"}
      >
        {children}
      </span>
    </span>
  );
}

const pillTone = {
  neutral: "border-gray-200 bg-white text-gray-700 dark:border-gray-800 dark:bg-white/[0.03] dark:text-gray-300",
  good: "border-success-100 bg-success-50 text-success-700 dark:border-success-500/20 dark:bg-success-500/10 dark:text-success-500",
  warn: "border-warning-100 bg-warning-50 text-warning-600 dark:border-warning-500/20 dark:bg-warning-500/10 dark:text-warning-500",
  bad: "border-error-100 bg-error-50 text-error-600 dark:border-error-500/20 dark:bg-error-500/10 dark:text-error-500",
  accent: "border-brand-100 bg-brand-50 text-brand-500 dark:border-brand-500/20 dark:bg-brand-500/10 dark:text-brand-400",
} as const;

export function Pill({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: keyof typeof pillTone;
}) {
  return (
    <span className={`inline-flex max-w-full truncate rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-4 ${pillTone[tone]}`}>
      {children}
    </span>
  );
}

export function PillList({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) {
    return <span className="text-xs text-muted">{empty}</span>;
  }
  return (
    <div className="flex max-w-52 flex-wrap gap-1">
      {items.map((item, index) => (
        <Pill key={`${index}:${item}`}>{item}</Pill>
      ))}
    </div>
  );
}

export function FilterChip({
  pressed,
  onToggle,
  children,
}: {
  pressed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onToggle}
      className={`whitespace-nowrap rounded-full border px-3 py-1 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
        pressed
          ? "border-brand-200 bg-brand-50 text-brand-500 dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-brand-400"
          : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-800 dark:bg-white/[0.03] dark:text-gray-300 dark:hover:bg-white/5"
      }`}
    >
      {children}
    </button>
  );
}

type Snapshot = {
  codec: string | null;
  quality: string | null;
  sizeBytes: number | null;
  sizePerHourGb: number | null;
  tracks: string[];
};

export function MediaSnapshot({
  snapshot,
  savingsBytes,
  emphasize,
}: {
  snapshot: Snapshot;
  savingsBytes?: number | null;
  emphasize?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        {snapshot.codec && <Pill tone={emphasize ? "accent" : "neutral"}>{snapshot.codec}</Pill>}
        {snapshot.quality && <Pill>{snapshot.quality}</Pill>}
        {snapshot.sizeBytes != null && (
          <span className="font-medium tabular-nums text-ink">{formatSize(snapshot.sizeBytes)}</span>
        )}
        {snapshot.sizePerHourGb != null && (
          <span className="text-xs tabular-nums text-muted">{snapshot.sizePerHourGb.toFixed(2)} GB/hr</span>
        )}
        {savingsBytes ? (
          <span className="text-xs font-medium text-good">save {formatSize(savingsBytes)}</span>
        ) : null}
      </div>
      {snapshot.tracks.length > 0 && (
        <div className="flex max-w-72 flex-wrap gap-1">
          {snapshot.tracks.map((track, index) => (
            <Pill key={`${index}:${track}`}>{track}</Pill>
          ))}
        </div>
      )}
    </div>
  );
}

export function VideoLabel({ label }: { label: string }) {
  if (label === "—" || label === "Unknown codec") {
    return <span className="text-xs text-muted">{label}</span>;
  }
  const [codec, detail] = label.split(" · ");
  return (
    <div className="leading-tight">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-ink">{codec}</div>
      {detail && <div className="text-[11px] text-muted">{detail}</div>}
    </div>
  );
}

export function PlanStatus({ lines }: { lines: string[] }) {
  if (lines.length === 1 && lines[0] === "Healthy") {
    return <Pill tone="good">Healthy</Pill>;
  }
  if (lines[0] === "Waiting for inspect") {
    return <span className="text-xs text-warn">{lines[0]}</span>;
  }
  return (
    <ul className="max-w-64 space-y-1 text-xs leading-5 text-muted">
      {lines.map((line, index) => (
        <li key={`${index}:${line}`}>{line}</li>
      ))}
    </ul>
  );
}
