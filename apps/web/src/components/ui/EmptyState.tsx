import React from 'react';

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;        // usually a button or link
  compact?: boolean;               // smaller padding, for inside tables/cards
  className?: string;
}

/**
 * EmptyState — standard "no data yet" panel.
 *
 * @example
 *   <EmptyState
 *     icon={<InboxIcon />}
 *     title="No sessions yet"
 *     description="Run origin enable in any repo to start tracking."
 *     action={<Link to="/docs" className="...">Setup guide</Link>}
 *   />
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  compact = false,
  className = '',
}: EmptyStateProps) {
  const padding = compact ? 'py-10' : 'py-20';
  return (
    <div className={`flex flex-col items-center justify-center text-center ${padding} px-6 ${className}`}>
      {icon && (
        <div className="w-10 h-10 rounded-full bg-gray-800/60 text-gray-500 flex items-center justify-center mb-4">
          {icon}
        </div>
      )}
      <h3 className="text-sm font-semibold text-gray-200 mb-1">{title}</h3>
      {description && (
        <p className="text-xs text-gray-500 max-w-sm leading-relaxed">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export default EmptyState;
