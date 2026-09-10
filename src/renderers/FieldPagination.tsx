import { formatNumber } from '../lib/format'
import type { PageWindow } from './grid'

interface Props {
  window: PageWindow
  onPage: (page: number) => void
  statusId: string
}

export function FieldPagination({ window: pageWindow, onPage, statusId }: Props) {
  if (!pageWindow.paginated) return null
  const first = pageWindow.startIndex + 1
  return (
    <div className="lcm-pagination">
      <p className="lcm-pagination-status" id={statusId}>
        Showing {formatNumber(first)} to {formatNumber(pageWindow.endIndex)} of {formatNumber(pageWindow.count)} environments, page {formatNumber(pageWindow.page)} of {formatNumber(pageWindow.pageCount)}. No environment is hidden without a page.
      </p>
      <div className="lcm-pagination-controls">
        <button type="button" className="lcm-button" onClick={() => onPage(pageWindow.page - 1)} disabled={pageWindow.page <= 1} aria-describedby={statusId}>Previous page</button>
        <button type="button" className="lcm-button" onClick={() => onPage(pageWindow.page + 1)} disabled={pageWindow.page >= pageWindow.pageCount} aria-describedby={statusId}>Next page</button>
      </div>
    </div>
  )
}
