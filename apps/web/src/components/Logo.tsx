import React from 'react';

export function LogoMark({ size = 32, className = '', variant = 'default' }: { size?: number; className?: string; variant?: 'default' | 'solo' }) {
  const id = variant === 'solo' ? 'solo' : 'def';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <defs>
        {variant === 'solo' ? (
          <>
            <linearGradient id={`logo-ring-${id}`} x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#10b981" />
              <stop offset="50%" stopColor="#059669" />
              <stop offset="100%" stopColor="#34d399" />
            </linearGradient>
            <linearGradient id={`logo-dot-${id}`} x1="220" y1="220" x2="292" y2="292" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#34d399" />
              <stop offset="100%" stopColor="#6ee7b7" />
            </linearGradient>
          </>
        ) : (
          <>
            <linearGradient id={`logo-ring-${id}`} x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#a855f7" />
              <stop offset="50%" stopColor="#6366f1" />
              <stop offset="100%" stopColor="#38bdf8" />
            </linearGradient>
            <linearGradient id={`logo-dot-${id}`} x1="220" y1="220" x2="292" y2="292" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#38bdf8" />
              <stop offset="100%" stopColor="#22d3ee" />
            </linearGradient>
          </>
        )}
      </defs>
      <circle cx="256" cy="256" r="180" stroke={`url(#logo-ring-${id})`} strokeWidth="48" fill="none" />
      <circle cx="256" cy="256" r="28" stroke={`url(#logo-dot-${id})`} strokeWidth="14" fill="none" />
    </svg>
  );
}
