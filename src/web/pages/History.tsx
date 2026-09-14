import { api, formatSize, type HistoryRow } from "../api";
import { PagedListControls } from "../components/PagedListControls";
import { Help, PageHead } from "../components/Shell";
import { usePagedList } from "../use-paged-list";

export function HistoryPage() {
  const list = usePagedList({ loadPage: api.history, keyOf: (row: HistoryRow) => row.id });
  const items = list.items;
  return (
    <section>
      <PageHead title="History" />
      <Help>History is the log of finished work: kept, discarded, flagged, failed, cancelled, searched, and removed.</Help>
      {items.length === 0 && list.loading && <div className="empty">Loading history…</div>}
      {items.length === 0 && !list.loading && !list.error && <div className="empty">No finished work yet.</div>}
      {items.length > 0 && (
        <div className="table-card">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Title</th>
                <th>Outcome</th>
                <th>Saved</th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={row.id}>
                  <td>{new Date(row.createdAt).toLocaleString()}</td>
                  <td>{row.displayTitle}</td>
                  <td>{row.outcome}</td>
                  <td>{row.bytesSaved ? formatSize(row.bytesSaved) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <PagedListControls loading={list.loading} error={list.error} nextOffset={list.nextOffset} noun="history" onLoadMore={list.loadMore} onRetry={list.reload} />
    </section>
  );
}
