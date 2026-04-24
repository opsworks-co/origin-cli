import React, { useState, useRef, useEffect } from 'react';

export interface DropdownItem {
  label?: string;
  description?: string;       // one-line hint rendered below the label
  onClick?: () => void;
  icon?: React.ReactNode;
  destructive?: boolean;      // red-tinted
  disabled?: boolean;
  divider?: boolean;          // render as divider, other fields ignored
  href?: string;              // render as anchor
}

interface DropdownProps {
  trigger: React.ReactElement;   // anything clickable; we wrap it
  items: DropdownItem[];
  align?: 'left' | 'right';
  className?: string;
}

/**
 * Dropdown — click-outside-to-close popover menu.
 *
 * Minimal, no-dependencies implementation. Use this for overflow actions,
 * account menus, select-like controls.
 *
 * @example
 *   <Dropdown
 *     trigger={<button>More</button>}
 *     items={[
 *       { label: 'Export', onClick: exportFn },
 *       { divider: true },
 *       { label: 'Delete', onClick: deleteFn, destructive: true },
 *     ]}
 *   />
 */
export function Dropdown({ trigger, items, align = 'right', className = '' }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const wrappedTrigger = React.cloneElement(trigger, {
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      setOpen((v) => !v);
      trigger.props.onClick?.(e);
    },
    'aria-expanded': open,
    'aria-haspopup': 'menu',
  });

  return (
    <div ref={rootRef} className={`relative inline-block ${className}`}>
      {wrappedTrigger}
      {open && (
        <div
          role="menu"
          className={`absolute top-full mt-1 min-w-[240px] rounded-lg border border-gray-800 bg-gray-900 shadow-xl py-1 z-50 ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          {items.map((item, i) => {
            if (item.divider) {
              return <div key={i} className="h-px bg-gray-800 my-1" aria-hidden />;
            }
            const common = 'w-full text-left flex items-start gap-2 px-3 py-2 text-xs transition-colors';
            const base = item.destructive
              ? 'text-red-400 hover:bg-red-500/10'
              : 'text-gray-300 hover:bg-gray-800';
            const disabled = item.disabled ? 'opacity-50 cursor-not-allowed' : '';
            const content = (
              <>
                {item.icon && <span className="mt-0.5 shrink-0">{item.icon}</span>}
                <span className="flex-1 min-w-0">
                  <span className="block">{item.label}</span>
                  {item.description && (
                    <span className="block text-[10px] text-gray-500 mt-0.5 leading-snug">
                      {item.description}
                    </span>
                  )}
                </span>
              </>
            );
            if (item.href) {
              return (
                <a
                  key={i}
                  href={item.href}
                  role="menuitem"
                  className={`${common} ${base} ${disabled}`}
                  onClick={() => setOpen(false)}
                >
                  {content}
                </a>
              );
            }
            return (
              <button
                key={i}
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  if (item.disabled) return;
                  item.onClick?.();
                  setOpen(false);
                }}
                className={`${common} ${base} ${disabled}`}
              >
                {content}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default Dropdown;
