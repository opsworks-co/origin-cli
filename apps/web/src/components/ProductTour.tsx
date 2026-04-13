import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { X, ChevronRight, ChevronLeft, Sparkles } from 'lucide-react';

// ── Tour step definition ────────────────────────────────────────────────────

export interface TourStep {
  /** CSS selector for the target element to highlight */
  target: string;
  /** Title shown in the tooltip */
  title: string;
  /** Description / explanation */
  content: string;
  /** Where to position the tooltip relative to the target */
  placement?: 'top' | 'bottom' | 'left' | 'right';
  /** Optional: navigate to this path before showing the step */
  route?: string;
  /** Optional: action hint shown as a small badge */
  action?: string;
  /** Optional: wait for this selector to appear after navigation */
  waitFor?: string;
}

// ── Tour definitions ────────────────────────────────────────────────────────

export const DASHBOARD_TOUR: TourStep[] = [
  {
    target: '[data-tour="sidebar-nav"]',
    title: 'Navigation',
    content: 'This is your main navigation. Dashboard shows your overview, Repositories manages your projects, and Sessions shows all your AI coding activity.',
    placement: 'right',
  },
  {
    target: '[data-tour="stat-cards"]',
    title: 'Your Stats at a Glance',
    content: 'These cards show your total sessions, tokens used, cost, and lines written. Click any card to see a breakdown by AI agent.',
    placement: 'bottom',
    action: 'Try clicking a card',
  },
  {
    target: '[data-tour="activity-heatmap"]',
    title: 'Activity Heatmap',
    content: 'Like GitHub\'s contribution graph but for AI coding. Each cell is one day — darker means more sessions. Hover for details.',
    placement: 'bottom',
  },
  {
    target: '[data-tour="dashboard-tabs"]',
    title: 'Dashboard Views',
    content: 'Switch between views: Sessions list, Timeline visualization, Agents breakdown, Stats, Patterns, Efficiency metrics, Prompt Search, and Commits.',
    placement: 'bottom',
    action: 'Explore each tab',
  },
  {
    target: '[data-tour="session-table"]',
    title: 'Session History',
    content: 'Every AI coding session is tracked here. You can see which agent was used, the repo, duration, cost, and token usage. Click any row to see the full session detail.',
    placement: 'top',
  },
  {
    target: '[data-tour="nav-repos"]',
    title: 'Repositories',
    content: 'View and manage your tracked repos. Import from GitHub/GitLab or track local repos. Sessions automatically link to their repo.',
    placement: 'right',
    route: '/repos',
  },
  {
    target: '[data-tour="nav-sessions"]',
    title: 'All Sessions',
    content: 'Advanced session view with filters by agent, repo, model, branch, and status. You can also group sessions by PR.',
    placement: 'right',
    route: '/sessions',
  },
  {
    target: '[data-tour="nav-insights"]',
    title: 'Insights',
    content: 'Deep analytics on your AI coding patterns — cost trends, productivity metrics, agent comparisons, and more.',
    placement: 'right',
  },
  {
    target: '[data-tour="nav-api-keys"]',
    title: 'API Keys',
    content: 'Manage your CLI authentication keys here. You need at least one key to connect the Origin CLI to your account.',
    placement: 'right',
    route: '/api-keys',
  },
  {
    target: '[data-tour="nav-integrations"]',
    title: 'Integrations',
    content: 'Connect GitHub and GitLab to auto-import repos, sync commits, and enable PR-level session tracking.',
    placement: 'right',
  },
];

// ── Tooltip positioning ─────────────────────────────────────────────────────

interface Position {
  top: number;
  left: number;
  arrowTop?: number;
  arrowLeft?: number;
  arrowDir: 'up' | 'down' | 'left' | 'right';
}

function calcPosition(rect: DOMRect, placement: string, tooltipW: number, tooltipH: number): Position {
  const gap = 14;
  const arrowSize = 8;
  const scrollY = window.scrollY;
  const scrollX = window.scrollX;

  switch (placement) {
    case 'bottom':
      return {
        top: rect.bottom + scrollY + gap,
        left: Math.max(12, Math.min(rect.left + scrollX + rect.width / 2 - tooltipW / 2, window.innerWidth - tooltipW - 12)),
        arrowTop: -arrowSize,
        arrowLeft: tooltipW / 2 - arrowSize,
        arrowDir: 'up',
      };
    case 'top':
      return {
        top: rect.top + scrollY - tooltipH - gap,
        left: Math.max(12, Math.min(rect.left + scrollX + rect.width / 2 - tooltipW / 2, window.innerWidth - tooltipW - 12)),
        arrowTop: tooltipH,
        arrowLeft: tooltipW / 2 - arrowSize,
        arrowDir: 'down',
      };
    case 'left':
      return {
        top: rect.top + scrollY + rect.height / 2 - tooltipH / 2,
        left: rect.left + scrollX - tooltipW - gap,
        arrowTop: tooltipH / 2 - arrowSize,
        arrowLeft: tooltipW,
        arrowDir: 'right',
      };
    case 'right':
    default:
      return {
        top: rect.top + scrollY + rect.height / 2 - tooltipH / 2,
        left: rect.right + scrollX + gap,
        arrowTop: tooltipH / 2 - arrowSize,
        arrowLeft: -arrowSize,
        arrowDir: 'left',
      };
  }
}

// ── Main component ──────────────────────────────────────────────────────────

interface ProductTourProps {
  steps: TourStep[];
  tourId: string;
  onComplete?: () => void;
}

export default function ProductTour({ steps, tourId, onComplete }: ProductTourProps) {
  const [active, setActive] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [pos, setPos] = useState<Position | null>(null);
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const [transitioning, setTransitioning] = useState(false);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const location = useLocation();

  const storageKey = `origin:tour-${tourId}`;

  // Check if tour already completed
  const isCompleted = () => {
    try { return localStorage.getItem(storageKey) === 'done'; } catch { return false; }
  };

  // Start tour
  const start = useCallback(() => {
    setCurrentStep(0);
    setActive(true);
    setTransitioning(false);
  }, []);

  // Complete / dismiss
  const complete = useCallback(() => {
    setActive(false);
    setPos(null);
    setTargetRect(null);
    try { localStorage.setItem(storageKey, 'done'); } catch {}
    onComplete?.();
  }, [storageKey, onComplete]);

  // Position the tooltip for the current step
  const positionTooltip = useCallback(() => {
    if (!active || transitioning) return;

    const step = steps[currentStep];
    if (!step) return;

    const el = document.querySelector(step.target);
    if (!el) {
      // Element not found — might need navigation or loading
      setPos(null);
      setTargetRect(null);
      return;
    }

    const rect = el.getBoundingClientRect();
    setTargetRect(rect);

    const tooltipW = 340;
    const tooltipH = tooltipRef.current?.offsetHeight || 180;
    const placement = step.placement || 'right';

    setPos(calcPosition(rect, placement, tooltipW, tooltipH));

    // Scroll element into view if needed
    if (rect.top < 0 || rect.bottom > window.innerHeight) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [active, currentStep, steps, transitioning]);

  // Navigate + reposition on step change
  useEffect(() => {
    if (!active) return;

    const step = steps[currentStep];
    if (!step) return;

    if (step.route && location.pathname !== step.route) {
      setTransitioning(true);
      navigate(step.route);
      // Wait for page to render
      const timer = setTimeout(() => {
        setTransitioning(false);
        positionTooltip();
      }, 400);
      return () => clearTimeout(timer);
    }

    // Small delay to let DOM settle
    const timer = setTimeout(positionTooltip, 100);
    return () => clearTimeout(timer);
  }, [active, currentStep, location.pathname]);

  // Re-position on scroll/resize
  useEffect(() => {
    if (!active) return;
    const handler = () => positionTooltip();
    window.addEventListener('scroll', handler, true);
    window.addEventListener('resize', handler);
    return () => {
      window.removeEventListener('scroll', handler, true);
      window.removeEventListener('resize', handler);
    };
  }, [active, positionTooltip]);

  // Navigation
  const next = () => {
    if (currentStep < steps.length - 1) {
      setTransitioning(true);
      setCurrentStep(c => c + 1);
    } else {
      complete();
    }
  };

  const prev = () => {
    if (currentStep > 0) {
      setTransitioning(true);
      setCurrentStep(c => c - 1);
    }
  };

  // Keyboard
  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') complete();
      if (e.key === 'ArrowRight' || e.key === 'Enter') next();
      if (e.key === 'ArrowLeft') prev();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [active, currentStep]);

  const step = steps[currentStep];

  // ── Start button (shown when tour not active and not completed) ──────
  if (!active) {
    if (isCompleted()) return null;
    return (
      <button
        onClick={start}
        data-tour="start-tour"
        className="fixed bottom-6 right-6 z-[9999] flex items-center gap-2 px-4 py-2.5 rounded-full bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium shadow-lg shadow-indigo-500/25 transition-all hover:scale-105 animate-bounce-gentle"
      >
        <Sparkles className="w-4 h-4" />
        Take a tour
      </button>
    );
  }

  return (
    <>
      {/* Overlay with cutout */}
      <div className="fixed inset-0 z-[9998]" onClick={complete}>
        <svg className="absolute inset-0 w-full h-full">
          <defs>
            <mask id="tour-mask">
              <rect x="0" y="0" width="100%" height="100%" fill="white" />
              {targetRect && (
                <rect
                  x={targetRect.left - 6}
                  y={targetRect.top - 6}
                  width={targetRect.width + 12}
                  height={targetRect.height + 12}
                  rx="8"
                  fill="black"
                />
              )}
            </mask>
          </defs>
          <rect
            x="0" y="0"
            width="100%" height="100%"
            fill="rgba(0,0,0,0.65)"
            mask="url(#tour-mask)"
          />
        </svg>

        {/* Highlight ring around target */}
        {targetRect && (
          <div
            className="absolute border-2 border-indigo-400 rounded-lg pointer-events-none animate-pulse-soft"
            style={{
              top: targetRect.top - 6,
              left: targetRect.left - 6,
              width: targetRect.width + 12,
              height: targetRect.height + 12,
            }}
          />
        )}
      </div>

      {/* Tooltip */}
      {pos && (
        <div
          ref={tooltipRef}
          className="fixed z-[9999] w-[340px] animate-fade-in"
          style={{ top: pos.top, left: pos.left }}
          onClick={e => e.stopPropagation()}
        >
          {/* Arrow */}
          <div
            className="absolute w-0 h-0"
            style={{
              top: pos.arrowTop,
              left: pos.arrowLeft,
              ...(pos.arrowDir === 'up' && {
                borderLeft: '8px solid transparent',
                borderRight: '8px solid transparent',
                borderBottom: '8px solid rgb(30, 32, 42)',
              }),
              ...(pos.arrowDir === 'down' && {
                borderLeft: '8px solid transparent',
                borderRight: '8px solid transparent',
                borderTop: '8px solid rgb(30, 32, 42)',
              }),
              ...(pos.arrowDir === 'left' && {
                borderTop: '8px solid transparent',
                borderBottom: '8px solid transparent',
                borderRight: '8px solid rgb(30, 32, 42)',
              }),
              ...(pos.arrowDir === 'right' && {
                borderTop: '8px solid transparent',
                borderBottom: '8px solid transparent',
                borderLeft: '8px solid rgb(30, 32, 42)',
              }),
            }}
          />

          {/* Card */}
          <div className="bg-[rgb(30,32,42)] border border-white/[0.1] rounded-xl shadow-2xl shadow-black/40 overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-4 pt-4 pb-1">
              <div className="flex items-center gap-2">
                <span className="flex items-center justify-center w-6 h-6 rounded-full bg-indigo-500/20 text-indigo-400 text-xs font-bold">
                  {currentStep + 1}
                </span>
                <h3 className="text-sm font-semibold text-white">{step.title}</h3>
              </div>
              <button
                onClick={complete}
                className="p-1 rounded-lg text-gray-500 hover:text-gray-300 hover:bg-white/[0.06] transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Body */}
            <div className="px-4 py-3">
              <p className="text-sm text-gray-400 leading-relaxed">{step.content}</p>
              {step.action && (
                <div className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-xs text-indigo-400">
                  <Sparkles className="w-3 h-3" />
                  {step.action}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between px-4 pb-4 pt-1">
              {/* Progress */}
              <div className="flex items-center gap-1">
                {steps.map((_, i) => (
                  <div
                    key={i}
                    className={`w-1.5 h-1.5 rounded-full transition-colors ${
                      i === currentStep ? 'bg-indigo-400' :
                      i < currentStep ? 'bg-indigo-600' : 'bg-gray-700'
                    }`}
                  />
                ))}
              </div>

              <div className="flex items-center gap-2">
                {currentStep > 0 && (
                  <button
                    onClick={prev}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs text-gray-400 hover:text-white hover:bg-white/[0.06] transition-colors"
                  >
                    <ChevronLeft className="w-3 h-3" />
                    Back
                  </button>
                )}
                <button
                  onClick={next}
                  className="flex items-center gap-1 px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-colors"
                >
                  {currentStep === steps.length - 1 ? 'Finish' : 'Next'}
                  {currentStep < steps.length - 1 && <ChevronRight className="w-3 h-3" />}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Custom animations */}
      <style>{`
        @keyframes bounce-gentle {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-4px); }
        }
        @keyframes pulse-soft {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
        .animate-bounce-gentle { animation: bounce-gentle 2s ease-in-out infinite; }
        .animate-pulse-soft { animation: pulse-soft 2s ease-in-out infinite; }
      `}</style>
    </>
  );
}

// ── Hook for restarting tour ────────────────────────────────────────────────

export function useRestartTour(tourId: string) {
  return useCallback(() => {
    try { localStorage.removeItem(`origin:tour-${tourId}`); } catch {}
    window.location.reload();
  }, [tourId]);
}
