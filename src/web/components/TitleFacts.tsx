import { formatSize, type ExternalLink, type LibraryRow } from "../api";
import { fileNameFromPath, formatDuration, hdrLabel } from "../title-display";
import { Pill } from "./ui";

export function TitleFacts({ item }: { item: LibraryRow }) {
  const report = item.report;
  const fileName = fileNameFromPath(item.path);
  const duration = formatDuration(report?.durationSec);
  const hdr = hdrLabel(report?.hdr);
  const facts = [
    item.instanceName,
    item.quality || null,
    formatSize(item.sizeBytes),
    item.videoLabel,
    duration,
    hdr,
    report?.bitDepth ? `${report.bitDepth}-bit` : null,
    report?.sizePerHourGb != null ? `${report.sizePerHourGb.toFixed(2)} GB/hr` : null,
    item.sharedFileLabel,
  ].filter((value): value is string => Boolean(value));

  return (
    <div className="glass flex flex-col gap-5 p-5 sm:flex-row">
      {item.hasPoster ? (
        <img
          src={`/api/library/${item.id}/poster`}
          alt=""
          className="h-48 w-32 shrink-0 rounded-lg object-cover ring-1 ring-white/10"
        />
      ) : (
        <div className="h-48 w-32 shrink-0 rounded bg-canvas ring-1 ring-ink/15" />
      )}
      <div className="min-w-0 flex-1 space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {facts.map((fact) => (
            <Pill key={fact}>{fact}</Pill>
          ))}
        </div>
        <dl className="space-y-2 text-sm">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-muted">File</dt>
            <dd className="mt-0.5 break-all font-medium text-ink">{fileName || "No file name from Radarr or Sonarr yet."}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-muted">Path</dt>
            <dd className="mt-0.5 break-all font-mono text-xs leading-5 text-muted">
              {item.path || "No file path from Radarr or Sonarr yet."}
            </dd>
          </div>
          {item.links && item.links.length > 0 && (
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-muted">Open</dt>
              <dd className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm">
                {item.links.map((link: ExternalLink) => (
                  <a key={link.href} className="text-brand-500 underline-offset-2 hover:underline" href={link.href} target="_blank" rel="noreferrer">
                    {link.label}
                  </a>
                ))}
              </dd>
            </div>
          )}
        </dl>
      </div>
    </div>
  );
}
