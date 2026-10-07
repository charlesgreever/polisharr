import { Link } from "react-router-dom";
import { api, type FileError } from "../api";
import { PagedListControls } from "../components/PagedListControls";
import { PageHead } from "../components/Shell";
import { usePagedList } from "../use-paged-list";

export function ErrorsPage() {
  const list = usePagedList({ loadPage: api.errors, keyOf: (row: FileError) => row.path });
  const items = list.items;
  return (
    <section>
      <PageHead title="Errors" />
      {items.length === 0 && list.loading && <div className="empty">Loading errors…</div>}
      {items.length === 0 && !list.loading && !list.error && <div className="empty">No unreadable files. Still-downloading titles are not errors.</div>}
      {items.length > 0 && (
        <div className="table-card">
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>File</th>
                <th>Path</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => {
                const href = errorHref(row);
                return (
                  <tr key={row.path}>
                    <td className="min-w-44">
                      {href ? (
                        <Link className="font-medium text-ink hover:text-accent" to={href}>
                          {row.displayTitle}
                        </Link>
                      ) : (
                        <span className="font-medium text-ink">{row.displayTitle}</span>
                      )}
                    </td>
                    <td>{row.fileName}</td>
                    <td className="text-xs text-muted">{row.path}</td>
                    <td>{row.reason}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <PagedListControls loading={list.loading} error={list.error} nextOffset={list.nextOffset} noun="errors" onLoadMore={list.loadMore} onRetry={list.reload} />
    </section>
  );
}

function errorHref(row: FileError): string {
  if (row.href) return row.href;
  if (!row.itemId) return "";
  return row.type === "episode" ? `/series/episodes/${row.itemId}` : `/movies/${row.itemId}`;
}
