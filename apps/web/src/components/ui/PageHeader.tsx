import React from 'react';
import { Breadcrumb, BreadcrumbItem } from './Breadcrumb';

interface PageHeaderProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;    // right-aligned buttons / toolbar
  breadcrumb?: BreadcrumbItem[];
  meta?: React.ReactNode;       // small strip under title+subtitle — pills, status, etc.
  className?: string;
}

/**
 * PageHeader — standard top-of-page header.
 *
 * Every authenticated page uses this. Matches the audit recommendation:
 * one primitive replaces 48 hand-rolled `<h1>` + `<p>` blocks.
 *
 * @example
 *   <PageHeader
 *     title="Sessions"
 *     subtitle="All AI coding sessions across your team"
 *     actions={<Button>Export</Button>}
 *   />
 *
 * @example
 *   <PageHeader
 *     breadcrumb={[
 *       { label: 'Sessions', to: '/sessions' },
 *       { label: session.id.slice(0,8) },
 *     ]}
 *     title={session.repoName}
 *     meta={<Pill variant="running">RUNNING</Pill>}
 *     actions={<ActionButtonGroup ... />}
 *   />
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  breadcrumb,
  meta,
  className = '',
}: PageHeaderProps) {
  return (
    <header className={`${className}`}>
      {breadcrumb && breadcrumb.length > 0 && (
        <div className="mb-2.5">
          <Breadcrumb items={breadcrumb} />
        </div>
      )}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          {typeof title === 'string' ? (
            <h1 className="text-xl font-semibold text-gray-100 tracking-tight leading-tight">
              {title}
            </h1>
          ) : (
            title
          )}
          {subtitle && (
            <p className="text-sm text-gray-500 mt-1">{subtitle}</p>
          )}
          {meta && <div className="mt-2 flex items-center gap-2 flex-wrap">{meta}</div>}
        </div>
        {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
      </div>
    </header>
  );
}

export default PageHeader;
