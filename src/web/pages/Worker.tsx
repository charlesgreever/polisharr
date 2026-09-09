import { useEffect, useState } from "react";
import { api, type WorkerStatus } from "../api";
import { ThemeToggle } from "../components/ThemeToggle";

export function WorkerPage() {
  const [data, setData] = useState<WorkerStatus | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let stop = false;
    const load = () => {
      void api.worker().then((payload) => {
        if (stop) return;
        setData(payload);
        setError("");
      }).catch((caught: Error) => {
        if (stop) return;
        setError(caught.message || "The worker status page could not load.");
      });
    };
    load();
    const id = setInterval(load, 4000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);

  const masterHref = data?.masterUrl ? safeHttpUrl(data.masterUrl) : null;

  return (
    <main className="auth-page relative">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <section className="auth-card">
        <div className="mb-8 flex items-center gap-3">
          <b className="grid h-8 w-8 place-items-center rounded-lg bg-brand-500 text-sm font-semibold text-white">P</b>
          <strong className="text-base font-semibold text-gray-800 dark:text-white/90">Polisharr</strong>
        </div>
        <p className="eyebrow">WORKER</p>
        <h1>{data?.name ?? "Worker"}</h1>
        <p>
          This Polisharr only runs encodes. Open the master to manage the library, queue, settings, Review, and Keep.
        </p>
        {data && (
          <dl className="mt-4 space-y-3 text-sm">
            <div>
              <dt className="font-medium text-muted">Master</dt>
              <dd>
                {masterHref ? (
                  <a className="text-brand-500 underline" href={masterHref}>{data.masterUrl}</a>
                ) : (
                  data.masterUrl ?? "Not set"
                )}
              </dd>
            </div>
            <div>
              <dt className="font-medium text-muted">Hardware</dt>
              <dd>{data.hardwareLabel}</dd>
            </div>
            <div>
              <dt className="font-medium text-muted">Status</dt>
              <dd>{data.detail}</dd>
            </div>
          </dl>
        )}
        {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
      </section>
    </main>
  );
}

export function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}
