import { useCallback, useEffect, useRef, useState } from "react";
import type { LibraryPage } from "./api";
import { refreshFirstPageByKey, retainedNextOffset } from "./library-pages";

type LoadMode = "reset" | "append" | "poll";

export function usePagedList<T>(options: {
  loadPage: (offset: number, limit: number) => Promise<LibraryPage<T>>;
  keyOf: (row: T) => string;
  queryKey?: string;
  pageSize?: number;
  pollMs?: number;
}) {
  const pageSize = options.pageSize ?? 50;
  const [items, setItems] = useState<T[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [total, setTotal] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const [finishedCount, setFinishedCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const itemsRef = useRef<T[]>([]);
  const loaderRef = useRef(options.loadPage);
  const keyRef = useRef(options.keyOf);
  const inFlightRef = useRef(false);
  const pendingResetRef = useRef(false);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const runRef = useRef<(offset: number, mode: LoadMode) => Promise<void>>(async () => undefined);
  loaderRef.current = options.loadPage;
  keyRef.current = options.keyOf;

  const run = useCallback(async (offset: number, mode: LoadMode) => {
    if (inFlightRef.current) {
      if (mode === "reset") pendingResetRef.current = true;
      return;
    }
    inFlightRef.current = true;
    const generation = generationRef.current;
    setLoading(true);
    setError("");
    try {
      const result = await loaderRef.current(offset, pageSize);
      if (!mountedRef.current || generation !== generationRef.current) return;
      const current = itemsRef.current;
      const nextItems =
        mode === "reset"
          ? result.items
          : mode === "append"
            ? mergeByKey(current, result.items, keyRef.current)
            : refreshFirstPageByKey(current, result.items, pageSize, result.total, keyRef.current);
      itemsRef.current = nextItems;
      setItems(nextItems);
      setNextOffset(mode === "poll" ? retainedNextOffset(nextItems.length, result.total) : result.nextOffset);
      setTotal(result.total);
      if (typeof result.pendingCount === "number") setPendingCount(result.pendingCount);
      if (typeof result.finishedCount === "number") setFinishedCount(result.finishedCount);
    } catch (cause) {
      if (mountedRef.current && generation === generationRef.current) {
        setError(cause instanceof Error ? cause.message : "This list could not be loaded.");
      }
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) setLoading(false);
      if (pendingResetRef.current && mountedRef.current) {
        pendingResetRef.current = false;
        void runRef.current(0, "reset");
      }
    }
  }, [pageSize]);
  runRef.current = run;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    generationRef.current += 1;
    itemsRef.current = [];
    setItems([]);
    setNextOffset(null);
    setTotal(0);
    setPendingCount(0);
    setFinishedCount(0);
    void run(0, "reset");
  }, [options.queryKey, run]);

  useEffect(() => {
    if (!options.pollMs) return;
    const interval = window.setInterval(() => void run(0, "poll"), options.pollMs);
    return () => window.clearInterval(interval);
  }, [options.pollMs, run]);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const generation = generationRef.current;
    setLoading(true);
    setError("");
    try {
      const want = Math.max(itemsRef.current.length, pageSize);
      let collected: T[] = [];
      let next: number | null = 0;
      let total = 0;
      let pendingCount = 0;
      let finishedCount = 0;
      while (next != null && collected.length < want) {
        const result = await loaderRef.current(next, pageSize);
        if (!mountedRef.current || generation !== generationRef.current) return;
        const previous: number | null = next;
        collected = mergeByKey(collected, result.items, keyRef.current);
        next = result.nextOffset;
        total = result.total;
        if (typeof result.pendingCount === "number") pendingCount = result.pendingCount;
        if (typeof result.finishedCount === "number") finishedCount = result.finishedCount;
        if (result.items.length === 0 || next === previous) break;
      }
      itemsRef.current = collected;
      setItems(collected);
      setNextOffset(next);
      setTotal(total);
      setPendingCount(pendingCount);
      setFinishedCount(finishedCount);
    } catch (cause) {
      if (mountedRef.current && generation === generationRef.current) {
        setError(cause instanceof Error ? cause.message : "This list could not be loaded.");
      }
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) setLoading(false);
    }
  }, [pageSize]);

  return {
    items,
    nextOffset,
    total,
    pendingCount,
    finishedCount,
    loading,
    error,
    loadMore: () => (nextOffset == null ? Promise.resolve() : run(nextOffset, "append")),
    reload: () => run(0, "reset"),
    refresh,
  };
}

function mergeByKey<T>(current: T[], incoming: T[], keyOf: (row: T) => string): T[] {
  const rows = new Map(current.map((row) => [keyOf(row), row]));
  for (const row of incoming) rows.set(keyOf(row), row);
  return [...rows.values()];
}
