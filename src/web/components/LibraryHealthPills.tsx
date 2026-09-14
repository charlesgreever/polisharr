import { Pill } from "./ui";

export function LibraryHealthPills({
  healthyCount,
  suggestionCount,
  work,
  onWorkChange,
}: {
  healthyCount: number;
  suggestionCount: number;
  work: boolean;
  onWorkChange: (work: boolean) => void;
}) {
  return (
    <span className="mt-1 flex flex-wrap items-center gap-1">
      <Pill tone="good">{healthyCount} healthy</Pill>
      <button
        type="button"
        aria-pressed={work}
        aria-label={work ? "Show every title" : "Show only titles that need work"}
        className="rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        onClick={() => onWorkChange(!work)}
      >
        <Pill tone={suggestionCount > 0 || work ? "accent" : "neutral"}>{suggestionCount} suggestions</Pill>
      </button>
    </span>
  );
}
