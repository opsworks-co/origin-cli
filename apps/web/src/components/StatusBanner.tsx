import React from 'react';
import { Link } from 'react-router-dom';

interface StatusBannerProps {
  unreviewed: number;
  policyViolations: number;
}

export default function StatusBanner({ unreviewed, policyViolations }: StatusBannerProps) {
  if (policyViolations > 0) {
    return (
      <Link
        to="/sessions?status=pending"
        className="block rounded-xl border border-red-800 bg-red-900/20 px-5 py-4 flex items-center gap-3 hover:bg-red-900/30 transition-colors cursor-pointer"
      >
        <span className="flex h-3 w-3 relative">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500" />
        </span>
        <div className="flex-1">
          <p className="text-red-400 font-semibold text-sm">Action Required</p>
          <p className="text-red-300/70 text-xs mt-0.5">
            {policyViolations} policy violation{policyViolations !== 1 ? 's' : ''} detected
            {unreviewed > 0 && ` \u00B7 ${unreviewed} session${unreviewed !== 1 ? 's' : ''} awaiting review`}
          </p>
        </div>
        <span className="text-red-400/50 text-sm">&rarr;</span>
      </Link>
    );
  }

  if (unreviewed > 0) {
    return (
      <Link
        to="/sessions?status=pending"
        className="block rounded-xl border border-amber-800 bg-amber-900/20 px-5 py-4 flex items-center gap-3 hover:bg-amber-900/30 transition-colors cursor-pointer"
      >
        <span className="flex h-3 w-3 relative">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-3 w-3 bg-amber-500" />
        </span>
        <div className="flex-1">
          <p className="text-amber-400 font-semibold text-sm">Needs Attention</p>
          <p className="text-amber-300/70 text-xs mt-0.5">
            {unreviewed} session{unreviewed !== 1 ? 's' : ''} awaiting review
          </p>
        </div>
        <span className="text-amber-400/50 text-sm">&rarr;</span>
      </Link>
    );
  }

  return (
    <div className="rounded-xl border border-green-800 bg-green-900/20 px-5 py-4 flex items-center gap-3">
      <span className="relative inline-flex rounded-full h-3 w-3 bg-green-500" />
      <div>
        <p className="text-green-400 font-semibold text-sm">All Clear</p>
        <p className="text-green-300/70 text-xs mt-0.5">
          All sessions reviewed, no policy violations
        </p>
      </div>
    </div>
  );
}
