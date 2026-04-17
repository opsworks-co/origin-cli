import React, { useState, useMemo, useEffect } from 'react';
import { ChevronUp, ChevronDown, ChevronsLeft, ChevronLeft, ChevronRight as ChevronRightIcon, ChevronsRight } from 'lucide-react';
import { EmptyState } from './EmptyState';

// ── Column definition ──────────────────────────────────────────────────

export interface DataTableColumn<T> {
  key: string;                                          // unique column id, also serves as sort key
  label: React.ReactNode;                               // header content
  align?: 'left' | 'center' | 'right';
  sortable?: boolean;                                   // enables click-to-sort
  sortValue?: (row: T) => string | number | null;       // custom value to sort on
  render: (row: T) => React.ReactNode;                  // cell content
  width?: string;                                       // optional fixed width (CSS)
  className?: string;                                   // applied to both th and td
  hideOnMobile?: boolean;                               // visual: hidden below sm
}

export type SortDir = 'asc' | 'desc';
export interface Sort {
  key: string;
  dir: SortDir;
}

// ── Pagination state ──────────────────────────────────────────────────

export interface PaginationConfig {
  pageSize: number;                                     // rows per page
  total?: number;                                       // if known, render "X–Y of Z"; if undefined, infer from data length
}

interface DataTableProps<T> {
  data: T[];
  columns: DataTableColumn<T>[];
  rowKey: (row: T) => string;                           // unique id per row
  onRowClick?: (row: T) => void;
  defaultSort?: Sort;
  filters?: React.ReactNode;                            // slot above the table for filter/search bar
  emptyState?: React.ReactNode;                         // rendered when data is empty AFTER filtering
  loading?: boolean;                                    // shows skeleton rows
  skeletonRows?: number;                                // how many skeleton rows to show (default 5)
  pagination?: PaginationConfig;
  selectable?: boolean;
  selectedKeys?: string[];
  onSelectionChange?: (keys: string[]) => void;
  rowClassName?: (row: T) => string;                    // extra class per-row (e.g., highlight selected)
  className?: string;
  // Server-side sort — if provided, DataTable does NOT sort internally;
  // it just calls onSortChange and expects `data` to already be sorted.
  serverSort?: boolean;
  sort?: Sort | null;                                   // controlled sort, required if serverSort=true
  onSortChange?: (sort: Sort) => void;
  // Server-side pagination — same pattern
  serverPagination?: boolean;
  page?: number;                                        // 0-based; controlled when serverPagination=true
  onPageChange?: (page: number) => void;
}

/**
 * DataTable — sortable, filterable, paginated, selectable table primitive.
 *
 * Replaces the 6+ hand-rolled `<table>` implementations in Sessions, Repos,
 * IAM, PullRequests, AuditLog, Trails, Notifications, Prompts, etc.
 *
 * ## Client-mode usage (default)
 *
 *     <DataTable
 *       data={sessions}
 *       columns={cols}
 *       rowKey={(s) => s.id}
 *       onRowClick={(s) => navigate(`/sessions/${s.id}`)}
 *       defaultSort={{ key: 'date', dir: 'desc' }}
 *       filters={<FilterBar ... />}
 *       pagination={{ pageSize: 50 }}
 *       emptyState={<EmptyState title="No sessions" ... />}
 *     />
 *
 * ## Server-mode usage
 *
 *     <DataTable
 *       data={pageOfSessions}
 *       columns={cols}
 *       rowKey={(s) => s.id}
 *       serverSort
 *       sort={sort}
 *       onSortChange={setSort}
 *       serverPagination
 *       page={page}
 *       pagination={{ pageSize: 50, total: totalCount }}
 *       onPageChange={setPage}
 *     />
 */
export function DataTable<T>({
  data,
  columns,
  rowKey,
  onRowClick,
  defaultSort,
  filters,
  emptyState,
  loading = false,
  skeletonRows = 5,
  pagination,
  selectable = false,
  selectedKeys = [],
  onSelectionChange,
  rowClassName,
  className = '',
  serverSort = false,
  sort: sortProp,
  onSortChange,
  serverPagination = false,
  page: pageProp,
  onPageChange,
}: DataTableProps<T>) {
  // ── Sort state ────────────────────────────────────────────────────
  const [internalSort, setInternalSort] = useState<Sort | null>(defaultSort || null);
  const sort = serverSort ? (sortProp || null) : internalSort;
  const setSort = (s: Sort) => {
    if (serverSort) onSortChange?.(s);
    else setInternalSort(s);
  };

  // ── Page state ────────────────────────────────────────────────────
  const [internalPage, setInternalPage] = useState(0);
  const page = serverPagination ? (pageProp ?? 0) : internalPage;
  const setPage = (p: number) => {
    if (serverPagination) onPageChange?.(p);
    else setInternalPage(p);
  };

  // Reset to page 0 when data shrinks (filter applied, etc.)
  useEffect(() => {
    if (serverPagination) return;
    const maxPage = pagination ? Math.max(0, Math.ceil(data.length / pagination.pageSize) - 1) : 0;
    if (internalPage > maxPage) setInternalPage(0);
  }, [data.length, pagination, serverPagination, internalPage]);

  // ── Client-side sort + paginate ──────────────────────────────────
  const sortedData = useMemo(() => {
    if (serverSort || !sort) return data;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return data;
    const getter = col.sortValue;
    const arr = [...data];
    arr.sort((a, b) => {
      const va = getter ? getter(a) : null;
      const vb = getter ? getter(b) : null;
      let cmp = 0;
      if (va == null && vb == null) cmp = 0;
      else if (va == null) cmp = -1;
      else if (vb == null) cmp = 1;
      else if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb;
      else cmp = String(va).localeCompare(String(vb));
      return sort.dir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [data, sort, columns, serverSort]);

  const pagedData = useMemo(() => {
    if (!pagination || serverPagination) return sortedData;
    const start = page * pagination.pageSize;
    return sortedData.slice(start, start + pagination.pageSize);
  }, [sortedData, pagination, page, serverPagination]);

  // ── Selection ────────────────────────────────────────────────────
  const allSelected = selectable && pagedData.length > 0 && pagedData.every((r) => selectedKeys.includes(rowKey(r)));
  const someSelected = selectable && pagedData.some((r) => selectedKeys.includes(rowKey(r))) && !allSelected;
  const selectAllRef = React.useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = !!someSelected;
  }, [someSelected]);

  function toggleAll() {
    if (!onSelectionChange) return;
    if (allSelected) {
      const pageKeys = pagedData.map(rowKey);
      onSelectionChange(selectedKeys.filter((k) => !pageKeys.includes(k)));
    } else {
      const pageKeys = pagedData.map(rowKey);
      onSelectionChange(Array.from(new Set([...selectedKeys, ...pageKeys])));
    }
  }

  function toggleRow(row: T) {
    if (!onSelectionChange) return;
    const k = rowKey(row);
    if (selectedKeys.includes(k)) onSelectionChange(selectedKeys.filter((x) => x !== k));
    else onSelectionChange([...selectedKeys, k]);
  }

  // ── Sort click ───────────────────────────────────────────────────
  function handleSortClick(col: DataTableColumn<T>) {
    if (!col.sortable) return;
    if (sort?.key === col.key) {
      setSort({ key: col.key, dir: sort.dir === 'asc' ? 'desc' : 'asc' });
    } else {
      setSort({ key: col.key, dir: col.align === 'right' ? 'desc' : 'asc' });
    }
  }

  // ── Derived pagination ───────────────────────────────────────────
  const totalCount = serverPagination
    ? (pagination?.total ?? sortedData.length)
    : sortedData.length;
  const totalPages = pagination ? Math.max(1, Math.ceil(totalCount / pagination.pageSize)) : 1;
  const from = pagination ? page * pagination.pageSize : 0;
  const to = pagination ? Math.min(from + pagination.pageSize, totalCount) : totalCount;

  // ── Render ───────────────────────────────────────────────────────
  const isEmpty = !loading && pagedData.length === 0;

  return (
    <div className={`rounded-xl border border-gray-800/60 bg-gray-900/20 overflow-hidden ${className}`}>
      {filters && (
        <div className="px-4 py-3 border-b border-gray-800/60 flex items-center gap-3 flex-wrap">
          {filters}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-800/60 text-[10px] uppercase tracking-wider text-gray-500">
              {selectable && (
                <th className="w-10 pl-4">
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    aria-label="Select all rows on this page"
                    className="rounded border-gray-700 bg-gray-800/60"
                  />
                </th>
              )}
              {columns.map((col) => {
                const isSorted = sort?.key === col.key;
                const alignCls = col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : 'text-left';
                const clickable = col.sortable ? 'cursor-pointer select-none hover:text-gray-300' : '';
                return (
                  <th
                    key={col.key}
                    onClick={() => handleSortClick(col)}
                    className={`px-4 py-3 font-medium ${alignCls} ${clickable} ${col.hideOnMobile ? 'hidden sm:table-cell' : ''} ${col.className || ''}`}
                    style={col.width ? { width: col.width } : undefined}
                  >
                    <span className={`inline-flex items-center gap-1 ${col.align === 'right' ? 'justify-end' : ''}`}>
                      {col.label}
                      {col.sortable && (
                        <span className="inline-flex flex-col -space-y-1 opacity-60">
                          <ChevronUp className={`w-2.5 h-2.5 ${isSorted && sort.dir === 'asc' ? 'text-indigo-400' : ''}`} />
                          <ChevronDown className={`w-2.5 h-2.5 ${isSorted && sort.dir === 'desc' ? 'text-indigo-400' : ''}`} />
                        </span>
                      )}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: skeletonRows }).map((_, i) => (
                  <tr key={`skeleton-${i}`} className="border-b border-gray-900">
                    {selectable && <td className="pl-4 py-3" />}
                    {columns.map((col) => (
                      <td key={col.key} className={`px-4 py-3 ${col.hideOnMobile ? 'hidden sm:table-cell' : ''}`}>
                        <div className="h-3 w-24 bg-gray-800/60 rounded animate-pulse" />
                      </td>
                    ))}
                  </tr>
                ))
              : pagedData.map((row) => {
                  const k = rowKey(row);
                  const selected = selectable && selectedKeys.includes(k);
                  const extra = rowClassName?.(row) || '';
                  return (
                    <tr
                      key={k}
                      onClick={onRowClick ? () => onRowClick(row) : undefined}
                      className={`border-b border-gray-900 last:border-0 ${onRowClick ? 'cursor-pointer hover:bg-gray-800/30' : ''} ${selected ? 'bg-indigo-500/5' : ''} ${extra} transition-colors`}
                    >
                      {selectable && (
                        <td className="pl-4 py-3" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() => toggleRow(row)}
                            aria-label="Select row"
                            className="rounded border-gray-700 bg-gray-800/60"
                          />
                        </td>
                      )}
                      {columns.map((col) => {
                        const alignCls = col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : 'text-left';
                        return (
                          <td
                            key={col.key}
                            className={`px-4 py-3 text-sm text-gray-300 ${alignCls} ${col.hideOnMobile ? 'hidden sm:table-cell' : ''} ${col.className || ''}`}
                          >
                            {col.render(row)}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
          </tbody>
        </table>
      </div>

      {isEmpty && (
        emptyState || (
          <EmptyState title="Nothing to show" compact />
        )
      )}

      {pagination && !loading && totalCount > pagination.pageSize && (
        <div className="px-4 py-3 border-t border-gray-800/60 flex items-center justify-between text-[11px] text-gray-500">
          <span>
            {from + 1}–{to} of {totalCount.toLocaleString()}
          </span>
          <div className="inline-flex items-center gap-1">
            <PageButton disabled={page === 0} onClick={() => setPage(0)} ariaLabel="First page"><ChevronsLeft className="w-3.5 h-3.5" /></PageButton>
            <PageButton disabled={page === 0} onClick={() => setPage(page - 1)} ariaLabel="Previous page"><ChevronLeft className="w-3.5 h-3.5" /></PageButton>
            <span className="px-2">
              Page {page + 1} of {totalPages}
            </span>
            <PageButton disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)} ariaLabel="Next page"><ChevronRightIcon className="w-3.5 h-3.5" /></PageButton>
            <PageButton disabled={page >= totalPages - 1} onClick={() => setPage(totalPages - 1)} ariaLabel="Last page"><ChevronsRight className="w-3.5 h-3.5" /></PageButton>
          </div>
        </div>
      )}
    </div>
  );
}

function PageButton({ children, onClick, disabled, ariaLabel }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; ariaLabel: string }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className="p-1 rounded hover:bg-gray-800/60 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
    >
      {children}
    </button>
  );
}

export default DataTable;
