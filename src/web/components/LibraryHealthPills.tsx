import { FilterChip, Pill } from "./ui";

export function LibraryHealthCounts({
  healthyCount,
  suggestionCount,
}: {
  healthyCount: number;
  suggestionCount: number;
}) {
  return (
    <span className="flex flex-wrap gap-1">
      <Pill tone="good">{healthyCount} healthy</Pill>
      <Pill tone={suggestionCount > 0 ? "accent" : "neutral"}>{suggestionCount} suggestions</Pill>
    </span>
  );
}

export function LibraryWorkFilter({
  work,
  onWorkChange,
  noun,
}: {
  work: boolean;
  onWorkChange: (work: boolean) => void;
  noun: "movies" | "episodes";
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium text-muted">Show</span>
      <FilterChip pressed={!work} onToggle={() => { if (work) onWorkChange(false); }}>
        {`All ${noun}`}
      </FilterChip>
      <FilterChip pressed={work} onToggle={() => { if (!work) onWorkChange(true); }}>
        Needs work
      </FilterChip>
      {work ? (
        <span className="text-xs text-muted">Suggestions, unread files, and files Polisharr could not read.</span>
      ) : (
        <span className="text-xs text-muted">Healthy files plus anything that still needs work.</span>
      )}
    </div>
  );
}

export function LibraryHealthPills({
  healthyCount,
  suggestionCount,
  work,
  onWorkChange,
  noun,
}: {
  healthyCount: number;
  suggestionCount: number;
  work: boolean;
  onWorkChange: (work: boolean) => void;
  noun: "movies" | "episodes";
}) {
  return (
    <span className="flex flex-col gap-2">
      <LibraryHealthCounts healthyCount={healthyCount} suggestionCount={suggestionCount} />
      <LibraryWorkFilter work={work} onWorkChange={onWorkChange} noun={noun} />
    </span>
  );
}
