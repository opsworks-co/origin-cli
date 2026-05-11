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
  // ── 1. Landing on the new Repositories-first sidebar ─────────────────
  {
    target: '[data-tour="sidebar-nav"]',
    title: 'Welcome to Origin',
    content: 'Your AI coding record. Three stops in the sidebar: Repositories, Sessions, Insights. We\'ll hit each one — takes about a minute.',
    placement: 'right',
    route: '/repos',
    delay: 200,
  },

  // ── 2. Repositories: starting point, then collapsible groups ─────────
  {
    target: '[data-tour="nav-repos"]',
    title: '1. Repositories',
    content: 'The default landing page. Every commit that lands in a tracked repo gets an AI attribution and a pointer to the session that produced it.',
    placement: 'right',
  },
  {
    target: '[data-tour="repos-actions"]',
    title: 'Add your repositories',
    content: 'Import from GitHub or GitLab, or paste a local checkout path with "Add Repo". Origin only tracks AI work in repos that show up here.',
    placement: 'bottom',
    delay: 200,
  },
  {
    target: '[data-tour="repo-group-header"]',
    title: 'Group by provider',
    content: 'Repos are grouped by GitHub org, GitLab namespace, or "Local". Click a header to collapse the group — the state persists across reloads.',
    placement: 'bottom',
    action: 'Click any header to toggle',
  },

  // ── 3. Sessions: list + pretty tool call rendering ───────────────────
  {
    target: '[data-tour="nav-sessions"]',
    title: '2. Sessions',
    content: 'Every AI coding run shows up here — agent, model, cost, duration, tokens. Open any row for the full transcript, with tool calls rendered as color-coded terminal rows (read / write / exec / MCP).',
    placement: 'right',
    route: '/sessions',
  },

  // ── 3. Snapshots: the feature most users don't know exists ──────────
  {
    target: '[data-tour="nav-snapshots"]',
    title: '3. Snapshots',
    content: 'Origin captures a snapshot of your working tree at every prompt — silently. Run `origin snapshot list` to see them, `origin snapshot restore <id>` to roll back to any past state. The Snapshots page indexes them across every session.',
    placement: 'right',
    route: '/snapshots',
  },

  // ── 4. Insights (was Dashboard) — the rest of the steps live at /me ──
  {
    target: '[data-tour="nav-insights"]',
    title: '4. Insights',
    content: 'Your personal dashboard — the old Dashboard and Insights pages live here now. Stat cards, a coding timeline, an activity heatmap, per-agent breakdown, and full prompt search.',
    placement: 'right',
    route: '/me',
  },
  {
    target: '[data-tour="stat-cards"]',
    title: 'Today at a glance',
    content: 'Sessions, tokens, spend, lines written. Click any card to expand into the agent-by-agent split.',
    placement: 'bottom',
    action: 'Cards expand on click',
  },
  {
    target: '[data-tour="tab-content-timeline"]',
    title: 'Coding timeline',
    content: 'Every session plotted on a single row of time, colored by agent. Fastest way to spot when and where the AI actually worked.',
    placement: 'top',
    delay: 300,
  },
  {
    target: '[data-tour="tab-stats"]',
    title: 'Stats & heatmap',
    content: 'Year-long activity heatmap plus top files, top repos, and agent usage. Darker cells = more AI work that day — streaks tick up here.',
    placement: 'bottom',
    clickBefore: '[data-tour="tab-stats"]',
    delay: 400,
  },
  {
    target: '[data-tour="tab-prompts"]',
    title: 'Prompt search',
    content: 'Every prompt you\'ve ever sent, searchable — indexed with the files each one changed. Find the prompt that produced great results and reuse it verbatim.',
    placement: 'bottom',
    clickBefore: '[data-tour="tab-prompts"]',
    delay: 300,
  },

  // ── 5. Commit drill-down: the new prompt → snapshot / blame links ─────
  {
    target: '[data-tour="nav-repos"]',
    title: 'One more thing — commit drill-down',
    content: 'Open a commit from Repositories → Repo → Commit. Each prompt card has "View snapshot →" and "Open AI blame →" — those now land on the exact prompt, not the whole session.',
    placement: 'right',
    route: '/repos',
  },

  // ── 6. Settings (tucked under Account) ────────────────────────────────
  {
    target: '[data-tour="nav-settings"]',
    title: 'Settings',
    content: 'API keys for the CLI, GitHub / GitLab integrations, general preferences. First time here? Start by creating an API key, then run `origin login --key …` locally.',
    placement: 'right',
    route: '/settings',
  },
];

// ── Team / org tour ─────────────────────────────────────────────────────────
// Counterpart to DASHBOARD_TOUR but for team admins. Walks through the seven
// surfaces an admin actually uses to get from "just signed up" to "team is
// productive": Dashboard → Repos → Agents → IAM → Policies → Budget →
// Insights. ~90 seconds end to end. Each step targets a stable
// `data-tour="..."` anchor so layout tweaks don't silently break the tour.
export const TEAM_TOUR: TourStep[] = [
  {
    target: '[data-tour="sidebar-nav"]',
    title: 'Welcome to Origin',
    content: 'Origin gives you visibility, governance, and budgets over every AI coding session your team runs. Quick tour — about 90 seconds.',
    placement: 'right',
    route: '/dashboard',
    delay: 200,
  },

  // ── Dashboard ─────────────────────────────────────────────────
  {
    target: '[data-tour="team-nav-dashboard"]',
    title: '1. Dashboard',
    content: 'The team\'s pulse. Sessions, tokens, cost, and adoption — all this week vs last week. Click any of the four KPI cards to break it down by agent.',
    placement: 'right',
    route: '/dashboard',
  },

  // ── Repositories ──────────────────────────────────────────────
  {
    target: '[data-tour="team-nav-repos"]',
    title: '2. Repositories',
    content: 'Connect GitHub, GitLab, or paste a repo path. Origin only tracks AI work in repos you\'ve added — this is the gate.',
    placement: 'right',
    route: '/repos',
  },

  // ── Agents ────────────────────────────────────────────────────
  {
    target: '[data-tour="team-nav-agents"]',
    title: '3. Agents',
    content: 'An agent is "Claude Code", "Cursor", "Codex", etc. Each one can have many models with their own per-model budgets and per-session caps.',
    placement: 'right',
    route: '/agents',
  },

  // ── IAM (the most-overlooked step in onboarding) ──────────────
  {
    target: '[data-tour="team-nav-iam"]',
    title: '4. Invite your team',
    content: 'Add engineers here. When you add a member, you pick the agents and repos their API key can access — scope on creation, no reconfiguration after.',
    placement: 'right',
    route: '/iam',
  },

  // ── Policies (with NL hint) ───────────────────────────────────
  {
    target: '[data-tour="team-nav-policies"]',
    title: '5. Policies',
    content: 'Block .env access, require human review on big sessions, cap costs, restrict models. Type a policy in plain English at the top — Origin generates the rules.',
    placement: 'right',
    route: '/policies',
  },

  // ── Budget ────────────────────────────────────────────────────
  {
    target: '[data-tour="team-nav-budget"]',
    title: '6. Budget',
    content: 'Set monthly caps per agent, per engineer, or per repo × model. Sessions block at the cap if you opt in. Slack + email alerts at 50/80/90/100%.',
    placement: 'right',
    route: '/budget',
  },

  // ── Insights / Analytics ──────────────────────────────────────
  {
    target: '[data-tour="team-nav-insights"]',
    title: '7. Insights',
    content: 'Deep analytics: AI-authorship % over time, cost-by-model, top engineers, adoption trend. Date-range filter on the right.',
    placement: 'right',
    route: '/insights',
  },

  // ── Wrap-up ───────────────────────────────────────────────────
  {
    target: '[data-tour="team-nav-dashboard"]',
    title: 'You\'re set',
    content: 'That\'s the tour. The Dashboard\'s "What did the team ship today?" banner is a nice place to land each morning. Re-run the tour anytime from the sidebar.',
    placement: 'right',
    route: '/dashboard',
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
  /** Where to navigate when the tour ends — Done click, X button, or
   *  Escape. Without this the user gets stranded on whichever route
   *  the final step navigated to (the dashboard tour ends on
   *  /settings, the team tour ends on /dashboard already). */
  completeRedirect?: string;
}

export default function ProductTour({ steps, tourId, onComplete, completeRedirect }: ProductTourProps) {
  // In-progress state has to survive component remounts. Each route in
  // App.tsx wraps its content in <AppLayout>, which means navigating from
  // /dashboard → /repos unmounts the AppLayout that contains ProductTour
  // and mounts a fresh one on the new route. Without persistence, `active`
  // and `currentStep` reset to defaults and the tour visibly "dies" on the
  // first route change. Use sessionStorage for in-progress state (one
  // browser session = one tour run) and localStorage for the completed
  // flag (sticks across sessions so we don't auto-relaunch every visit).
  const sessionKey = `origin:tour-state-${tourId}`;
  const storageKey = `origin:tour-${tourId}`;

  const initial = (() => {
    try {
      const raw = sessionStorage.getItem(sessionKey);
      if (!raw) return { active: false, step: 0 };
      const parsed = JSON.parse(raw) as { active?: boolean; step?: number };
      return {
        active: !!parsed.active,
        step: typeof parsed.step === 'number' && parsed.step >= 0 ? parsed.step : 0,
      };
    } catch { return { active: false, step: 0 }; }
  })();

  const [active, setActive] = useState(initial.active);
  const [currentStep, setCurrentStep] = useState(initial.step);
  const [pos, setPos] = useState<Position | null>(null);
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const [transitioning, setTransitioning] = useState(false);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const location = useLocation();

  // Mirror in-progress state to sessionStorage so route remounts can rehydrate.
  useEffect(() => {
    try {
      if (active) {
        sessionStorage.setItem(sessionKey, JSON.stringify({ active, step: currentStep }));
      } else {
        sessionStorage.removeItem(sessionKey);
      }
    } catch { /* ignore */ }
  }, [active, currentStep, sessionKey]);

  const isCompleted = () => {
    try { return localStorage.getItem(storageKey) === 'done'; } catch { return false; }
  };

  const start = useCallback(() => {
    setCurrentStep(0);
    setActive(true);
    setTransitioning(false);
  }, []);

  // External trigger: sidebar "Tour" button dispatches origin:start-tour so
  // the tour starts immediately instead of redirecting + showing a second
  // "Take a tour" button that the user has to click again.
  useEffect(() => {
    const handler = () => {
      try { localStorage.removeItem(storageKey); } catch {}
      start();
    };
    window.addEventListener('origin:start-tour', handler);
    return () => window.removeEventListener('origin:start-tour', handler);
  }, [start, storageKey]);

  // Auto-start if the sidebar button navigated here with ?tour=1 (the cross-
  // page case — ProductTour isn't mounted on /repos so the event dispatch
  // would have no listener; the URL param survives the navigation).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('tour') === '1') {
      try { localStorage.removeItem(storageKey); } catch {}
      start();
      // Clean up the URL so a refresh doesn't reopen the tour.
      params.delete('tour');
      const q = params.toString();
      window.history.replaceState({}, '', window.location.pathname + (q ? `?${q}` : ''));
    }
    // First-login auto-start. Register pages set
    // \`origin:auto-start-tour = '1'\` after a successful signup; the tour
    // fires once and the flag is cleared. Distinct from
    // \`origin:tour-highlight\` which only pulses the sidebar button —
    // that nudge stays for users who close the auto-tour and want a
    // visible reminder.
    try {
      if (localStorage.getItem('origin:auto-start-tour') === '1') {
        localStorage.removeItem('origin:auto-start-tour');
        localStorage.removeItem(storageKey);
        // Small delay so the layout has time to mount + render anchors
        // (sidebar nav items the tour highlights). 600ms matches the
        // Register → /me redirect cadence.
        setTimeout(() => start(), 600);
      }
    } catch { /* private mode */ }
    // Only run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const complete = useCallback(() => {
    setActive(false);
    setPos(null);
    setTargetRect(null);
    try {
      localStorage.setItem(storageKey, 'done');
      sessionStorage.removeItem(sessionKey);
    } catch {}
    onComplete?.();
    // Send the user "home" after the tour. The last step's route
    // (Settings for solo, Dashboard for team) is rarely where the
    // user actually wants to land — without this we stranded solo
    // devs on /settings after the final "Done — let's go!" click.
    if (completeRedirect && location.pathname !== completeRedirect) {
      navigate(completeRedirect);
    }
  }, [storageKey, sessionKey, onComplete, completeRedirect, navigate, location.pathname]);

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

      // 3. Wait for target element to appear. Some tabs (Timeline/Patterns)
      //    lazy-mount recharts + heavy charts so 2s was too short — tour got
      //    stuck around step 5-6 with transitioning=true forever. Bump the
      //    window to ~6s AND always release the transitioning lock so the
      //    user at least sees the tooltip in a fallback centered position
      //    (positionTooltip handles missing targets).
      let retries = 0;
      while (retries < 30) {
        await wait(200);
        if (cancelled) return;
        const el = document.querySelector(step.target);
        if (el) break;
        retries++;
      }

      if (cancelled) return;
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

  // No bottom-right FAB — the tour only starts when the sidebar "Tour"
  // button dispatches origin:start-tour, so there's never a second button
  // to click after the user has already asked for the tour.
  if (!active) return null;

  return (
    <>
      {/* Overlay with cutout. No click-to-dismiss — during the up-to-6s
          window where the next step's target is loading, the tooltip is
          briefly hidden, and an impatient click anywhere on the dim layer
          used to silently complete the tour. The X / "Skip tour" buttons
          inside the tooltip card are the only ways out now. */}
      <div className="fixed inset-0 z-[9998]">
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
