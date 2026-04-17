import React from 'react';

export type PillVariant =
  | 'success'     // emerald — approved, completed, success
  | 'warning'     // amber — end/pause/needs-attention
  | 'error'       // red — destructive, failed
  | 'info'        // sky — informational, neutral metric
  | 'neutral'     // gray — default
  | 'running'     // purple — live / in-progress state
  | 'ai';         // indigo — AI metric / action affordance

interface PillProps {
  children: React.ReactNode;
  variant?: PillVariant;
  icon?: React.ReactNode;
  muted?: boolean;    // lower-emphasis variant (gray text, smaller)
  size?: 'sm' | 'md'; // sm = caption-size, md = body-small
  title?: string;     // tooltip
  className?: string;
}

const VARIANT_CLASSES: Record<PillVariant, string> = {
  success: 'bg-emerald-500/15 text-emerald-400 ring-emerald-500/25',
  warning: 'bg-amber-500/15 text-amber-400 ring-amber-500/25',
  error:   'bg-red-500/15 text-red-400 ring-red-500/25',
  info:    'bg-sky-500/15 text-sky-400 ring-sky-500/25',
  neutral: 'bg-gray-800/60 text-gray-400 ring-gray-700/40',
  running: 'bg-purple-500/15 text-purple-400 ring-purple-500/25',
  ai:      'bg-indigo-500/15 text-indigo-400 ring-indigo-500/25',
};

const MUTED_CLASSES: Record<PillVariant, string> = {
  success: 'text-emerald-500/70',
  warning: 'text-amber-500/70',
  error:   'text-red-500/70',
  info:    'text-sky-500/70',
  neutral: 'text-gray-500',
  running: 'text-purple-500/70',
  ai:      'text-indigo-500/70',
};

/**
 * Pill — small labeled chip used for status, metadata, or metrics.
 *
 * @example
 *   <Pill variant="success">Approved</Pill>
 *   <Pill variant="running" icon={<PulseDot />}>RUNNING</Pill>
 *   <Pill variant="neutral" muted size="sm">3 prompts</Pill>
 */
export function Pill({
  children,
  variant = 'neutral',
  icon,
  muted = false,
  size = 'sm',
  title,
  className = '',
}: PillProps) {
  const sizeClasses = size === 'sm'
    ? 'text-[11px] px-2 py-0.5'
    : 'text-xs px-2.5 py-1';

  if (muted) {
    return (
      <span
        title={title}
        className={`inline-flex items-center gap-1 ${sizeClasses} ${MUTED_CLASSES[variant]} ${className}`}
      >
        {icon}
        {children}
      </span>
    );
  }

  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 ${sizeClasses} rounded-md ring-1 font-medium ${VARIANT_CLASSES[variant]} ${className}`}
    >
      {icon}
      {children}
    </span>
  );
}

/**
 * PulseDot — the animated dot used inside running-state Pills and live indicators.
 */
export function PulseDot({ variant = 'running' }: { variant?: PillVariant }) {
  const colorMap: Record<PillVariant, string> = {
    success: 'bg-emerald-500',
    warning: 'bg-amber-500',
    error:   'bg-red-500',
    info:    'bg-sky-500',
    neutral: 'bg-gray-500',
    running: 'bg-purple-500',
    ai:      'bg-indigo-500',
  };
  const ping = colorMap[variant].replace('bg-', 'bg-').replace('-500', '-400');
  return (
    <span className="relative flex h-2 w-2">
      <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${ping} opacity-75`} />
      <span className={`relative inline-flex rounded-full h-2 w-2 ${colorMap[variant]}`} />
    </span>
  );
}

export default Pill;
