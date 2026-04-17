import React from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';

export interface BreadcrumbItem {
  label: string;
  to?: string;        // if present, renders as Link; if absent, renders as current
  onClick?: () => void; // alternative to `to`
}

interface BreadcrumbProps {
  items: BreadcrumbItem[];
  className?: string;
}

/**
 * Breadcrumb — top-of-page navigation trail.
 *
 * Last item has no link (it's the current page). Separators are chevrons.
 *
 * @example
 *   <Breadcrumb items={[
 *     { label: 'Sessions', to: '/sessions' },
 *     { label: 'abc1234' },
 *   ]} />
 */
export function Breadcrumb({ items, className = '' }: BreadcrumbProps) {
  if (items.length === 0) return null;
  return (
    <nav aria-label="Breadcrumb" className={`flex items-center gap-1.5 text-[11px] text-gray-500 ${className}`}>
      {items.map((item, i) => {
        const isLast = i === items.length - 1;
        return (
          <React.Fragment key={`${item.label}-${i}`}>
            {i > 0 && <ChevronRight className="w-3 h-3 text-gray-700" aria-hidden />}
            {isLast || (!item.to && !item.onClick) ? (
              <span className={isLast ? 'text-gray-300' : ''}>{item.label}</span>
            ) : item.to ? (
              <Link to={item.to} className="hover:text-gray-300 transition-colors">
                {item.label}
              </Link>
            ) : (
              <button onClick={item.onClick} className="hover:text-gray-300 transition-colors">
                {item.label}
              </button>
            )}
          </React.Fragment>
        );
      })}
    </nav>
  );
}

export default Breadcrumb;
