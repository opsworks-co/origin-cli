import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Helmet } from 'react-helmet-async';
import { Link } from 'react-router-dom';

// ── Step data ─────────────────────────────────────────────────────────────────

interface TerminalLine {
  text: string;
  color?: string; // tailwind text color class
  delay?: number; // ms before this line appears (unused for now, kept for future)
}

interface Step {
  title: string;
  caption: string;
  command: string; // the "$ ..." line that gets typewriter effect
  output: TerminalLine[];
}

const STEPS: Step[] = [
  {
    title: 'Install the Origin CLI',
    command: '$ npm install -g https://getorigin.io/cli/origin-cli-latest.tgz',
    caption:
      'Install Origin globally with npm. Works on macOS, Linux, and Windows.',
    output: [
      { text: '' },
      { text: 'added 1 package in 2.1s', color: 'text-gray-400' },
      { text: '' },
      { text: '$ origin --version', color: 'text-green-400' },
      { text: 'origin/0.20260402.2100', color: 'text-white' },
    ],
  },
  {
    title: 'Initialize Origin (one command, every repo)',
    command: '$ origin init',
    caption:
      'Sets git config --global core.hooksPath so every repo on your machine is tracked automatically. No per-repo setup. Auto-detects Claude Code, Cursor, Codex, Gemini — and 9 more agents.',
    output: [
      { text: '' },
      {
        text: '\u{1F50D} Detecting AI coding tools...',
        color: 'text-gray-300',
      },
      {
        text: '  \u2713 Claude Code detected (claude-sonnet-4)',
        color: 'text-green-400',
      },
      { text: '  \u2713 Cursor detected', color: 'text-green-400' },
      { text: '  \u2713 Codex CLI detected', color: 'text-green-400' },
      { text: '' },
      {
        text: '\u{1F4E1} Installing GLOBAL git hooks',
        color: 'text-cyan-400',
      },
      {
        text: '  \u2713 Every repo on this machine \u2014 past and future \u2014 is now tracked',
        color: 'text-green-400',
      },
      { text: '' },
      {
        text: 'Run any AI coding tool \u2014 sessions are captured automatically.',
        color: 'text-gray-500',
      },
    ],
  },
  {
    title: 'Code with any AI agent',
    command:
      '$ claude "add input validation to the user registration endpoint"',
    caption:
      'Use any AI tool as usual. Origin captures the session automatically \u2014 every prompt, every file change, every token.',
    output: [
      { text: '' },
      {
        text: '[Claude Code] Working on src/routes/auth.ts...',
        color: 'text-gray-400',
      },
      { text: '' },
      {
        text: '\u2501\u2501\u2501 Origin Session #1847 \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501',
        color: 'text-indigo-400',
      },
      {
        text: '  Agent:    Claude Code (claude-sonnet-4)',
        color: 'text-white',
      },
      { text: '  Repo:     acme/backend', color: 'text-white' },
      {
        text: '  Files:    src/routes/auth.ts, src/validators/user.ts',
        color: 'text-white',
      },
      { text: '  Duration: 3m 42s', color: 'text-white' },
      { text: '  Tokens:   12,847 in / 3,291 out', color: 'text-white' },
      { text: '  Cost:     $0.12', color: 'text-cyan-400' },
      {
        text: '  Policy:   \u2713 No violations',
        color: 'text-green-400',
      },
      {
        text: '\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501',
        color: 'text-indigo-400',
      },
    ],
  },
  {
    title: 'View AI blame',
    command: '$ origin blame src/routes/auth.ts',
    caption:
      'See exactly which lines were written by AI and which by humans. Like git blame, but AI-aware.',
    output: [
      { text: '' },
      // Each blame line rendered with mixed colors via special markup
      // We use a special "blame" color to signal custom rendering
      {
        text: "  12 \u2502 import { z } from 'zod';           \u2502 human    \u2502 3 days ago",
        color: 'blame-human',
      },
      {
        text: '  13 \u2502                                     \u2502          \u2502',
        color: 'text-gray-600',
      },
      {
        text: '  14 \u2502 const registerSchema = z.object({   \u2502 claude   \u2502 2 min ago  \u2190 AI',
        color: 'blame-ai',
      },
      {
        text: '  15 \u2502   email: z.string().email(),        \u2502 claude   \u2502 2 min ago  \u2190 AI',
        color: 'blame-ai',
      },
      {
        text: '  16 \u2502   password: z.string().min(8),      \u2502 claude   \u2502 2 min ago  \u2190 AI',
        color: 'blame-ai',
      },
      {
        text: '  17 \u2502   name: z.string().min(1),          \u2502 claude   \u2502 2 min ago  \u2190 AI',
        color: 'blame-ai',
      },
      {
        text: '  18 \u2502 });                                 \u2502 claude   \u2502 2 min ago  \u2190 AI',
        color: 'blame-ai',
      },
      {
        text: '  19 \u2502                                     \u2502          \u2502',
        color: 'text-gray-600',
      },
      {
        text: "  20 \u2502 router.post('/register', async (req)\u2502 human    \u2502 3 days ago",
        color: 'blame-human',
      },
    ],
  },
  {
    title: 'Undo a bad AI turn with snapshots',
    command: '$ origin snapshot list',
    caption:
      'Every AI prompt auto-saves a working-tree snapshot. Time-travel back to any prompt without losing work \u2014 stored on orphan git branches, no commits polluted.',
    output: [
      { text: '' },
      {
        text: '  a1b2c3d  2m ago   1 file   [auto]   add JWT refresh',
        color: 'text-gray-300',
      },
      {
        text: '  5f8e9a0  8m ago   1 file   [auto]   fix broken token edge case',
        color: 'text-gray-300',
      },
      {
        text: '  d2c4b6a  14m ago  3 files  [auto]   refactor auth middleware',
        color: 'text-gray-300',
      },
      {
        text: '  7e1f3a2  22m ago  2 files  [auto]   add rate limiting',
        color: 'text-amber-400',
      },
      { text: '' },
      {
        text: '$ origin snapshot restore 7e1f3a2',
        color: 'text-green-400',
      },
      { text: '' },
      {
        text: '\u2713 Stashed uncommitted changes',
        color: 'text-green-400',
      },
      { text: '\u2713 Restored 2 files', color: 'text-green-400' },
      { text: '\u2713 No commits modified', color: 'text-green-400' },
      { text: '' },
      {
        text: 'Back to stash with `git stash pop`.',
        color: 'text-gray-500',
      },
    ],
  },
  {
    title: 'Check session status',
    command: '$ origin status',
    caption:
      'Get a quick overview of AI activity in your repo. Track costs, violations, and pending reviews.',
    output: [
      { text: '' },
      {
        text: '\u{1F4CA} Origin Status \u2014 acme/backend',
        color: 'text-white',
      },
      {
        text: '\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501',
        color: 'text-indigo-400',
      },
      { text: '  Sessions today:     7', color: 'text-white' },
      {
        text: '  AI-authored lines:  342 / 891 (38%)',
        color: 'text-cyan-400',
      },
      { text: '  Total cost today:   $1.47', color: 'text-white' },
      {
        text: '  Policy violations:  0',
        color: 'text-green-400',
      },
      { text: '  Pending reviews:    2', color: 'text-yellow-400' },
      { text: '' },
      { text: 'Recent sessions:', color: 'text-gray-400' },
      {
        text: '  #1847  Claude Code   src/routes/auth.ts      3m   $0.12  \u2713',
        color: 'text-green-400',
      },
      {
        text: '  #1846  Cursor        src/components/Form.tsx  8m   $0.31  \u2713',
        color: 'text-green-400',
      },
      {
        text: '  #1845  Claude Code   src/db/migrations/...   2m   $0.08  \u26A0 review',
        color: 'text-yellow-400',
      },
      {
        text: '\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501',
        color: 'text-indigo-400',
      },
    ],
  },
];

const INSTALL_CMD = 'npm install -g https://getorigin.io/cli/origin-cli-latest.tgz';

// ── Blame line renderer ───────────────────────────────────────────────────────

function BlameLine({ text, type }: { text: string; type: 'human' | 'ai' }) {
  // Split the blame line at the pipe characters for coloring
  const parts = text.split('\u2502');
  if (parts.length < 4) return <span className="text-gray-300">{text}</span>;

  const lineNum = parts[0];
  const code = parts[1];
  const author = parts[2];
  const time = parts[3];

  const aiMarker = type === 'ai' && time.includes('\u2190 AI');
  const timePart = aiMarker ? time.replace('\u2190 AI', '') : time;

  return (
    <span>
      <span className="text-gray-600">{lineNum}</span>
      <span className="text-gray-600">{'\u2502'}</span>
      <span className={type === 'human' ? 'text-gray-300' : 'text-indigo-300'}>
        {code}
      </span>
      <span className="text-gray-600">{'\u2502'}</span>
      <span className={type === 'human' ? 'text-green-400' : 'text-indigo-400'}>
        {author}
      </span>
      <span className="text-gray-600">{'\u2502'}</span>
      <span className="text-gray-500">{timePart}</span>
      {aiMarker && <span className="text-cyan-400">{'\u2190 AI'}</span>}
    </span>
  );
}

// ── Terminal component ────────────────────────────────────────────────────────

function TerminalWindow({
  command,
  output,
  isActive,
}: {
  command: string;
  output: TerminalLine[];
  isActive: boolean;
}) {
  const [typedLength, setTypedLength] = useState(0);
  const [showOutput, setShowOutput] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!isActive) {
      setTypedLength(0);
      setShowOutput(false);
      return;
    }

    // Reset on activation
    setTypedLength(0);
    setShowOutput(false);

    // Start typewriter
    let i = 0;
    intervalRef.current = setInterval(() => {
      i++;
      if (i >= command.length) {
        setTypedLength(command.length);
        if (intervalRef.current) clearInterval(intervalRef.current);
        // Show output after command finishes typing
        setTimeout(() => setShowOutput(true), 200);
      } else {
        setTypedLength(i);
      }
    }, 30);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isActive, command]);

  const displayedCmd = command.slice(0, typedLength);
  const cursorVisible = isActive && typedLength < command.length;

  return (
    <div className="rounded-xl overflow-hidden border border-gray-700/60 shadow-2xl shadow-black/40">
      {/* Title bar */}
      <div className="bg-gray-800 border-b border-gray-700/60 px-4 py-2.5 flex items-center gap-3">
        {/* Traffic lights */}
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-full bg-red-500/80" />
          <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
          <div className="w-3 h-3 rounded-full bg-green-500/80" />
        </div>
        <span className="text-xs text-gray-500 font-mono ml-2 select-none">
          Terminal &mdash; zsh
        </span>
      </div>

      {/* Terminal body */}
      <div className="bg-[#0d0e1a] px-5 py-4 min-h-[280px] sm:min-h-[320px] font-mono text-sm whitespace-pre leading-relaxed overflow-x-auto">
        {/* Command line with typewriter */}
        <div>
          <span className="text-green-400">{displayedCmd}</span>
          {cursorVisible && (
            <span className="inline-block w-2 h-4 bg-green-400 align-middle animate-pulse ml-px" />
          )}
        </div>

        {/* Output lines */}
        {showOutput && (
          <div className="animate-fadeIn">
            {output.map((line, i) => {
              if (line.color === 'blame-human') {
                return (
                  <div key={i}>
                    <BlameLine text={line.text} type="human" />
                  </div>
                );
              }
              if (line.color === 'blame-ai') {
                return (
                  <div key={i}>
                    <BlameLine text={line.text} type="ai" />
                  </div>
                );
              }
              return (
                <div key={i} className={line.color || 'text-gray-300'}>
                  {line.text || '\u00A0'}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Copy button ───────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button
      onClick={handleCopy}
      className="shrink-0 px-3 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function CLITour({ embedded = false }: { embedded?: boolean }) {
  const [currentStep, setCurrentStep] = useState(0);
  const [autoPlay, setAutoPlay] = useState(true);

  // Auto-advance
  useEffect(() => {
    if (!autoPlay) return;
    const id = setInterval(() => {
      setCurrentStep((prev) => (prev + 1) % STEPS.length);
    }, 5000);
    return () => clearInterval(id);
  }, [autoPlay]);

  const goTo = useCallback(
    (idx: number) => {
      setCurrentStep(idx);
      setAutoPlay(false);
    },
    [],
  );

  const prev = useCallback(() => {
    setCurrentStep((s) => (s === 0 ? STEPS.length - 1 : s - 1));
    setAutoPlay(false);
  }, []);

  const next = useCallback(() => {
    setCurrentStep((s) => (s + 1) % STEPS.length);
    setAutoPlay(false);
  }, []);

  const step = STEPS[currentStep];

  return (
    <>
      {!embedded && (
        <Helmet>
          <title>CLI Demo &mdash; Origin | See the Origin CLI in Action</title>
          <meta
            name="description"
            content="Interactive walkthrough of the Origin CLI. See how to install, configure, and use Origin to track AI coding sessions."
          />
        </Helmet>
      )}

      <div className={embedded ? 'text-white' : 'min-h-screen bg-[#0a0b14] text-white'}>
        {!embedded && (
          <header className="border-b border-gray-800 bg-[#0a0b14]/80 backdrop-blur-sm sticky top-0 z-30">
            <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
              <Link to="/" className="text-lg font-semibold text-white tracking-tight">
                Origin
              </Link>
              <div className="flex items-center gap-4">
                <Link to="/docs#cli" className="text-sm text-gray-400 hover:text-white transition-colors">Full Docs</Link>
                <Link to="/register" className="text-sm bg-indigo-600 hover:bg-indigo-500 px-4 py-1.5 rounded-lg font-medium transition-colors">Get Started</Link>
              </div>
            </div>
          </header>
        )}

        <main className={embedded ? '' : 'max-w-5xl mx-auto px-4 sm:px-6 py-10 sm:py-16'}>
          {!embedded && (
            <div className="text-center mb-10 sm:mb-14">
              <h1 className="text-3xl sm:text-4xl font-bold tracking-tight mb-3">
                Origin CLI in Action
              </h1>
              <p className="text-gray-400 text-lg max-w-2xl mx-auto">
                A step-by-step walkthrough of the Origin command-line tool. See how
                it integrates with your workflow in under a minute.
              </p>
            </div>
          )}

          {/* ── Step indicators ────────────────────────────────────── */}
          <div className="flex items-center justify-center gap-2 mb-8 flex-wrap">
            {STEPS.map((s, i) => (
              <button
                key={i}
                onClick={() => goTo(i)}
                className={`
                  px-3 py-1.5 rounded-full text-xs font-medium transition-all cursor-pointer
                  ${
                    i === currentStep
                      ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/25'
                      : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200'
                  }
                `}
              >
                {i + 1}. {s.title}
              </button>
            ))}
          </div>

          {/* ── Terminal ───────────────────────────────────────────── */}
          <div className="mb-6">
            <TerminalWindow
              key={currentStep}
              command={step.command}
              output={step.output}
              isActive={true}
            />
          </div>

          {/* ── Caption ───────────────────────────────────────────── */}
          <p className="text-center text-gray-400 text-sm sm:text-base max-w-2xl mx-auto mb-8">
            {step.caption}
          </p>

          {/* ── Controls ──────────────────────────────────────────── */}
          <div className="flex items-center justify-center gap-4 mb-20">
            <button
              onClick={prev}
              className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-sm font-medium transition-colors cursor-pointer"
            >
              &larr; Prev
            </button>

            <button
              onClick={() => setAutoPlay((a) => !a)}
              className={`
                px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer
                ${
                  autoPlay
                    ? 'bg-indigo-600/20 text-indigo-400 border border-indigo-500/40 hover:bg-indigo-600/30'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                }
              `}
            >
              {autoPlay ? 'Auto-playing' : 'Auto-play off'}
            </button>

            <button
              onClick={next}
              className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-sm font-medium transition-colors cursor-pointer"
            >
              Next &rarr;
            </button>
          </div>

          {/* ── CTA ───────────────────────────────────────────────── */}
          {!embedded && (
          <div className="border border-gray-800 rounded-2xl bg-gray-900/50 p-8 sm:p-10 text-center">
            <h2 className="text-2xl font-bold mb-2">Ready to install?</h2>
            <p className="text-gray-400 mb-6">
              One command. That&apos;s all it takes.
            </p>

            <div className="flex items-center gap-3 max-w-2xl mx-auto bg-[#0d0e1a] border border-gray-700 rounded-xl px-5 py-3.5 mb-8">
              <span className="text-green-400 font-mono text-sm shrink-0">$</span>
              <code className="font-mono text-sm text-gray-200 truncate flex-1 text-left">
                {INSTALL_CMD}
              </code>
              <CopyButton text={INSTALL_CMD} />
            </div>

            <div className="flex items-center justify-center gap-6 text-sm">
              <Link
                to="/register"
                className="text-indigo-400 hover:text-indigo-300 font-medium transition-colors"
              >
                Create an account &rarr;
              </Link>
              <Link
                to="/docs#cli"
                className="text-gray-400 hover:text-gray-200 transition-colors"
              >
                Full CLI documentation
              </Link>
            </div>
          </div>
          )}
        </main>
      </div>

      {/* Inline keyframe for fade-in animation */}
      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .animate-fadeIn {
          animation: fadeIn 0.3s ease-out forwards;
        }
      `}</style>
    </>
  );
}

export default function DemoCLIPage() {
  return <CLITour />;
}
