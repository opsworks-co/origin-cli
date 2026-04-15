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
  /** Optional: click this selector before showing the step (e.g. to switch tabs) */
  clickBefore?: string;
  /** Optional: delay (ms) after click/navigation before positioning tooltip */
  delay?: number;
}

// ── Tour definitions ────────────────────────────────────────────────────────

export const DASHBOARD_TOUR: TourStep[] = [
  // ── Overview ──────────────────────────────────────────────────────────
  {
    target: '[data-tour="sidebar-nav"]',
    title: 'Welcome to Origin',
    content: 'This is your command center. Let\'s walk through everything — starting with the dashboard, then each section of the platform.',
    placement: 'right',
    route: '/me',
  },
  {
    target: '[data-tour="stat-cards"]',
    title: 'Stats Overview',
    content: 'Your key metrics at a glance — total sessions, tokens consumed, accumulated cost, and lines of code written. Click any card to expand an agent-by-agent breakdown.',
    placement: 'bottom',
    action: 'Click a card to expand it',
  },
  {
    target: '[data-tour="activity-heatmap"]',
    title: 'Activity Heatmap',
    content: 'Your coding activity over the past year. Darker cells = more AI sessions that day. Hover any cell to see the exact count. Build a streak!',
    placement: 'bottom',
    clickBefore: '[data-tour="tab-stats"]',
    delay: 500,
  },

  // ── Sessions tab ──────────────────────────────────────────────────────
  {
    target: '[data-tour="tab-sessions"]',
    title: 'Sessions Tab',
    content: 'This is your default view — a complete list of every AI coding session. Let\'s look at what\'s inside.',
    placement: 'bottom',
    clickBefore: '[data-tour="tab-sessions"]',
  },
  {
    target: '[data-tour="session-table"]',
    title: 'Session History',
    content: 'Each row is one AI session — which agent, which repo, branch, duration, cost, and tokens. Click a row to see the full detail: every prompt, tool call, and file change.',
    placement: 'top',
    action: 'Click any session for details',
    delay: 500,
  },

  // ── Timeline tab ──────────────────────────────────────────────────────
  {
    target: '[data-tour="tab-timeline"]',
    title: 'Timeline View',
    content: 'A chronological view of your sessions. See when you switched between agents, how long each session lasted, and spot patterns in your workflow.',
    placement: 'bottom',
    clickBefore: '[data-tour="tab-timeline"]',
  },
  {
    target: '[data-tour="tab-content-timeline"]',
    title: 'Your Coding Timeline',
    content: 'Each dot is a session, colored by agent. The vertical timeline shows your day-by-day activity. Look for patterns — when do you code most? Which agents do you reach for?',
    placement: 'top',
    delay: 300,
  },

  // ── Agents tab ────────────────────────────────────────────────────────
  {
    target: '[data-tour="tab-agents"]',
    title: 'Agents Breakdown',
    content: 'See all the AI agents you\'ve used — Claude Code, Cursor, Gemini, Copilot, and more. Each gets its own card with detailed stats.',
    placement: 'bottom',
    clickBefore: '[data-tour="tab-agents"]',
  },
  {
    target: '[data-tour="tab-content-agents"]',
    title: 'Agent Cards',
    content: 'Each card shows an agent\'s total sessions, cost, tokens, lines written, and last active time. Compare agents side by side to see which ones you use most and which are most efficient.',
    placement: 'top',
    delay: 300,
  },

  // ── Stats tab ─────────────────────────────────────────────────────────
  {
    target: '[data-tour="tab-stats"]',
    title: 'Detailed Stats',
    content: 'The full stats view with your activity heatmap, agent usage pie chart, top files, and repo breakdown — all in one place.',
    placement: 'bottom',
    clickBefore: '[data-tour="tab-stats"]',
  },

  // ── Patterns tab ──────────────────────────────────────────────────────
  {
    target: '[data-tour="tab-patterns"]',
    title: 'Coding Patterns',
    content: 'Discover when you\'re most productive. Hourly and daily breakdowns reveal your peak coding hours, average session length, and monthly trends.',
    placement: 'bottom',
    clickBefore: '[data-tour="tab-patterns"]',
  },
  {
    target: '[data-tour="tab-content-patterns"]',
    title: 'Your Peak Hours',
    content: 'The hour-by-hour chart shows when you start AI sessions most. The daily chart shows which days of the week you code. Use this to optimize your schedule around your most productive windows.',
    placement: 'top',
    delay: 400,
  },

  // ── Efficiency tab ────────────────────────────────────────────────────
  {
    target: '[data-tour="tab-efficiency"]',
    title: 'Efficiency Metrics',
    content: 'How efficient is your AI coding? This tab tracks tokens per line of code, cost per commit, cache usage, and which tools your agents call most.',
    placement: 'bottom',
    clickBefore: '[data-tour="tab-efficiency"]',
  },
  {
    target: '[data-tour="tab-content-efficiency"]',
    title: 'Cost & Output Ratios',
    content: 'Key ratios: tokens per line written, cost per commit, average lines per session. Lower tokens-per-line = more efficient prompting. High cache hit rates = better context reuse.',
    placement: 'top',
    delay: 400,
  },

  // ── Prompts tab ───────────────────────────────────────────────────────
  {
    target: '[data-tour="tab-prompts"]',
    title: 'Prompt Search',
    content: 'Search across all your prompts. Find that one prompt that produced great results and reuse it. Every prompt is indexed with the files it changed.',
    placement: 'bottom',
    clickBefore: '[data-tour="tab-prompts"]',
  },

  // ── Commits tab ───────────────────────────────────────────────────────
  {
    target: '[data-tour="tab-commits"]',
    title: 'Commit History',
    content: 'Every commit linked to AI sessions. See which commits were AI-assisted, the detection method, and click to view the full diff.',
    placement: 'bottom',
    clickBefore: '[data-tour="tab-commits"]',
  },

  // ── Other pages ───────────────────────────────────────────────────────
  {
    target: '[data-tour="nav-repos"]',
    title: 'Repositories',
    content: 'Import repos from GitHub/GitLab or track local ones. When you start an AI session in a tracked repo, it auto-links — so you can see all sessions per project.',
    placement: 'right',
    route: '/repos',
  },
  {
    target: '[data-tour="nav-live"]',
    title: 'Live Feed',
    content: 'Watch your AI sessions in real time. See active sessions with live token counters, cost tickers, and an event log of everything happening across your projects.',
    placement: 'right',
    route: '/live',
  },
  {
    target: '[data-tour="nav-insights"]',
    title: 'Insights',
    content: 'Deep analytics and trends — cost over time, productivity scores, agent comparisons, and team benchmarks. The bigger picture of your AI coding.',
    placement: 'right',
  },
  {
    target: '[data-tour="nav-api-keys"]',
    title: 'API Keys',
    content: 'Create and manage API keys for CLI authentication. Each key connects an Origin CLI installation to your account. You need at least one to start tracking.',
    placement: 'right',
    route: '/api-keys',
  },
  {
    target: '[data-tour="nav-integrations"]',
    title: 'Integrations',
    content: 'Connect GitHub and GitLab for automatic repo syncing, commit imports, and PR-level session linking. This is where you manage all your provider connections.',
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

  const isCompleted = () => {
    try { return localStorage.getItem(storageKey) === 'done'; } catch { return false; }
  };

  const start = useCallback(() => {
    setCurrentStep(0);
    setActive(true);
    setTransitioning(false);
  }, []);

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
      // Fallback: show tooltip centered on screen without highlight
      setTargetRect(null);
      setPos({
        top: Math.max(window.innerHeight / 2 - 100, 60),
        left: Math.max(window.innerWidth / 2 - 180, 20),
        arrowTop: undefined as any,
        arrowLeft: undefined as any,
        arrowDir: 'up' as const,
      });
      return;
    }

    const rect = el.getBoundingClientRect();
    setTargetRect(rect);

    const tooltipW = 360;
    const tooltipH = tooltipRef.current?.offsetHeight || 200;
    const placement = step.placement || 'right';

    setPos(calcPosition(rect, placement, tooltipW, tooltipH));

    // Scroll element into view if needed
    if (rect.top < 0 || rect.bottom > window.innerHeight) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [active, currentStep, steps, transitioning]);

  // Execute step setup: navigation + clickBefore + positioning
  useEffect(() => {
    if (!active) return;

    const step = steps[currentStep];
    if (!step) return;

    let cancelled = false;

    const run = async () => {
      setTransitioning(true);
      setPos(null);
      setTargetRect(null);

      // 1. Navigate if needed
      if (step.route && location.pathname !== step.route) {
        navigate(step.route);
        await wait(400);
        if (cancelled) return;
      }

      // 2. Click a button before showing the step (e.g. switch tabs)
      if (step.clickBefore) {
        const btn = document.querySelector(step.clickBefore) as HTMLElement;
        if (btn) {
          btn.click();
          await wait(step.delay || 200);
          if (cancelled) return;
        }
      } else if (step.delay) {
        await wait(step.delay);
        if (cancelled) return;
      }

      // 3. Wait for target element to appear (retry up to 2s for lazy-loaded content)
      let retries = 0;
      while (retries < 10) {
        await wait(200);
        if (cancelled) return;
        const el = document.querySelector(step.target);
        if (el) break;
        retries++;
      }

      setTransitioning(false);
    };

    run();

    return () => { cancelled = true; };
  }, [active, currentStep]);

  // Re-position when transitioning ends
  useEffect(() => {
    if (!active || transitioning) return;
    positionTooltip();
  }, [active, transitioning, positionTooltip]);

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

  const next = () => {
    if (currentStep < steps.length - 1) {
      setCurrentStep(c => c + 1);
    } else {
      complete();
    }
  };

  const prev = () => {
    if (currentStep > 0) {
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

  // ── Start button ──────────────────────────────────────────────────────
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
        <svg className="absolute inset-0 w-full h-full" style={{ pointerEvents: 'none' }}>
          <defs>
            <mask id="tour-mask">
              <rect x="0" y="0" width="100%" height="100%" fill="white" />
              {targetRect && (
                <rect
                  x={targetRect.left - 8}
                  y={targetRect.top - 8}
                  width={targetRect.width + 16}
                  height={targetRect.height + 16}
                  rx="10"
                  fill="black"
                />
              )}
            </mask>
          </defs>
          <rect
            x="0" y="0"
            width="100%" height="100%"
            fill="rgba(0,0,0,0.6)"
            mask="url(#tour-mask)"
            style={{ pointerEvents: 'all' }}
          />
        </svg>

        {/* Highlight ring */}
        {targetRect && (
          <div
            className="absolute rounded-xl pointer-events-none ring-2 ring-indigo-400/80 ring-offset-2 ring-offset-transparent"
            style={{
              top: targetRect.top - 8,
              left: targetRect.left - 8,
              width: targetRect.width + 16,
              height: targetRect.height + 16,
              boxShadow: '0 0 0 4px rgba(99, 102, 241, 0.15), 0 0 20px rgba(99, 102, 241, 0.1)',
            }}
          />
        )}
      </div>

      {/* Tooltip */}
      {pos && step && (
        <div
          ref={tooltipRef}
          className="fixed z-[9999] w-[360px]"
          style={{ top: pos.top, left: pos.left, animation: 'tour-fade-in 0.2s ease-out' }}
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
                borderBottom: '8px solid rgb(24, 26, 36)',
              }),
              ...(pos.arrowDir === 'down' && {
                borderLeft: '8px solid transparent',
                borderRight: '8px solid transparent',
                borderTop: '8px solid rgb(24, 26, 36)',
              }),
              ...(pos.arrowDir === 'left' && {
                borderTop: '8px solid transparent',
                borderBottom: '8px solid transparent',
                borderRight: '8px solid rgb(24, 26, 36)',
              }),
              ...(pos.arrowDir === 'right' && {
                borderTop: '8px solid transparent',
                borderBottom: '8px solid transparent',
                borderLeft: '8px solid rgb(24, 26, 36)',
              }),
            }}
          />

          {/* Card */}
          <div className="bg-[rgb(24,26,36)] border border-white/[0.1] rounded-xl shadow-2xl shadow-black/50 overflow-hidden">
            {/* Progress bar at top */}
            <div className="h-1 bg-gray-800">
              <div
                className="h-full bg-gradient-to-r from-indigo-500 to-purple-500 transition-all duration-300"
                style={{ width: `${((currentStep + 1) / steps.length) * 100}%` }}
              />
            </div>

            {/* Header */}
            <div className="flex items-center justify-between px-5 pt-4 pb-1">
              <div className="flex items-center gap-2.5">
                <span className="flex items-center justify-center w-7 h-7 rounded-full bg-indigo-500/20 text-indigo-400 text-xs font-bold ring-1 ring-indigo-500/30">
                  {currentStep + 1}
                </span>
                <h3 className="text-[15px] font-semibold text-white">{step.title}</h3>
              </div>
              <button
                onClick={complete}
                className="p-1.5 rounded-lg text-gray-500 hover:text-gray-300 hover:bg-white/[0.06] transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Body */}
            <div className="px-5 py-3">
              <p className="text-[13px] text-gray-400 leading-relaxed">{step.content}</p>
              {step.action && (
                <div className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-xs font-medium text-indigo-400">
                  <Sparkles className="w-3 h-3" />
                  {step.action}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between px-5 pb-4 pt-1">
              <span className="text-[11px] text-gray-600">
                {currentStep + 1} of {steps.length}
              </span>

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
                {currentStep === 0 && (
                  <button
                    onClick={complete}
                    className="px-3 py-1.5 rounded-lg text-xs text-gray-500 hover:text-gray-300 hover:bg-white/[0.06] transition-colors"
                  >
                    Skip tour
                  </button>
                )}
                <button
                  onClick={next}
                  className="flex items-center gap-1 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-colors"
                >
                  {currentStep === steps.length - 1 ? "Done — let's go!" : 'Next'}
                  {currentStep < steps.length - 1 && <ChevronRight className="w-3 h-3" />}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Animations */}
      <style>{`
        @keyframes bounce-gentle {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-4px); }
        }
        @keyframes tour-fade-in {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .animate-bounce-gentle { animation: bounce-gentle 2s ease-in-out infinite; }
      `}</style>
    </>
  );
}

function wait(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Hook for restarting tour ────────────────────────────────────────────────

export function useRestartTour(tourId: string) {
  return useCallback(() => {
    try { localStorage.removeItem(`origin:tour-${tourId}`); } catch {}
    window.location.reload();
  }, [tourId]);
}
