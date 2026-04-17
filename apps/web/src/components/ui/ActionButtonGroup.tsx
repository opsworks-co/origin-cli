import React from 'react';
import { MoreVertical } from 'lucide-react';
import { Dropdown, DropdownItem } from './Dropdown';

export interface ActionButton {
  label: string;
  onClick?: () => void;
  icon?: React.ReactNode;
  disabled?: boolean;
  loading?: boolean;
  loadingLabel?: string;
  variant?: 'primary' | 'secondary' | 'warning' | 'ghost';
  title?: string;           // tooltip
  href?: string;            // if set, renders anchor
}

interface ActionButtonGroupProps {
  primary?: ActionButton;           // prominent CTA (indigo)
  secondary?: ActionButton[];       // neutral buttons
  overflow?: DropdownItem[];        // items in the ⋯ menu
  className?: string;
}

const VARIANT_CLASSES: Record<NonNullable<ActionButton['variant']>, string> = {
  primary:   'bg-indigo-500 hover:bg-indigo-400 text-white border border-indigo-400/30',
  secondary: 'bg-gray-700/50 hover:bg-gray-700 text-gray-200 border border-gray-600/50',
  warning:   'bg-amber-500/15 hover:bg-amber-500/25 text-amber-400 border border-amber-500/25',
  ghost:     'text-gray-400 hover:text-gray-200 hover:bg-gray-800/60 border border-transparent',
};

function renderButton(b: ActionButton) {
  const classes = `inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${VARIANT_CLASSES[b.variant || 'secondary']}`;
  const content = (
    <>
      {b.icon}
      {b.loading ? (b.loadingLabel || 'Working...') : b.label}
    </>
  );
  if (b.href) {
    return (
      <a href={b.href} className={classes} title={b.title}>
        {content}
      </a>
    );
  }
  return (
    <button
      onClick={b.onClick}
      disabled={b.disabled || b.loading}
      title={b.title}
      className={classes}
    >
      {content}
    </button>
  );
}

/**
 * ActionButtonGroup — toolbar of primary + secondary + overflow actions.
 *
 * Standard layout: primary button on the right of the toolbar, secondaries to
 * its left, overflow `⋯` menu on the far right if provided.
 *
 * @example
 *   <ActionButtonGroup
 *     primary={{ label: 'New Session', onClick: create }}
 *     secondary={[
 *       { label: 'Share', onClick: share },
 *       { label: 'Export', onClick: exportFn },
 *     ]}
 *     overflow={[
 *       { label: 'Archive', onClick: archive },
 *       { divider: true },
 *       { label: 'Delete', onClick: del, destructive: true },
 *     ]}
 *   />
 */
export function ActionButtonGroup({
  primary,
  secondary = [],
  overflow,
  className = '',
}: ActionButtonGroupProps) {
  const hasOverflow = overflow && overflow.length > 0;
  return (
    <div className={`inline-flex items-center gap-2 ${className}`}>
      {secondary.map((b, i) => (
        <React.Fragment key={`sec-${i}`}>{renderButton(b)}</React.Fragment>
      ))}
      {primary && renderButton({ ...primary, variant: primary.variant || 'primary' })}
      {hasOverflow && (
        <Dropdown
          trigger={
            <button
              className="inline-flex items-center justify-center w-7 h-7 rounded-md text-gray-300 bg-gray-700/50 border border-gray-600/50 hover:bg-gray-700 transition-colors"
              aria-label="More actions"
            >
              <MoreVertical className="w-4 h-4" />
            </button>
          }
          items={overflow}
        />
      )}
    </div>
  );
}

export default ActionButtonGroup;
