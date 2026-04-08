import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Helmet } from 'react-helmet-async';
import { Link } from 'react-router-dom';
import { LogoMark } from '../components/Logo';

// ── Animated aurora background ──────────────────────────────────────────────
function AuroraBackground() {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      <div className="aurora-blob aurora-1" />
      <div className="aurora-blob aurora-2" />
      <div className="aurora-blob aurora-3" />
      {/* Noise overlay */}
      <div className="absolute inset-0 opacity-[0.015]"
        style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg viewBox=\'0 0 256 256\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cfilter id=\'n\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'0.9\' numOctaves=\'4\' stitchTiles=\'stitch\'/%3E%3C/filter%3E%3Crect width=\'100%25\' height=\'100%25\' filter=\'url(%23n)\'/%3E%3C/svg%3E")' }} />
    </div>
  );
}

// ── Floating particles ──────────────────────────────────────────────────────
function Particles() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;
    const particles: { x: number; y: number; vx: number; vy: number; size: number; alpha: number; color: string }[] = [];
    const colors = ['99,102,241', '168,85,247', '56,189,248', '16,185,129'];

    const resize = () => { canvas.width = canvas.offsetWidth; canvas.height = canvas.offsetHeight; };
    resize();
    window.addEventListener('resize', resize);

    for (let i = 0; i < 40; i++) {
      particles.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        vx: (Math.random() - 0.5) * 0.3,
        vy: (Math.random() - 0.5) * 0.3,
        size: Math.random() * 2 + 0.5,
        alpha: Math.random() * 0.3 + 0.1,
        color: colors[Math.floor(Math.random() * colors.length)],
      });
    }

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      particles.forEach((p) => {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0) p.x = canvas.width;
        if (p.x > canvas.width) p.x = 0;
        if (p.y < 0) p.y = canvas.height;
        if (p.y > canvas.height) p.y = 0;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${p.color},${p.alpha})`;
        ctx.fill();
      });

      // Draw connections
      particles.forEach((a, i) => {
        particles.slice(i + 1).forEach((b) => {
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 120) {
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.strokeStyle = `rgba(99,102,241,${0.06 * (1 - dist / 120)})`;
            ctx.lineWidth = 0.5;
            ctx.stroke();
          }
        });
      });

      animId = requestAnimationFrame(draw);
    };
    draw();
    return () => { cancelAnimationFrame(animId); window.removeEventListener('resize', resize); };
  }, []);

  return <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />;
}

// ── Staggered text reveal ───────────────────────────────────────────────────
function RevealText({ children, delay = 0, className = '' }: { children: React.ReactNode; delay?: number; className?: string }) {
  const [show, setShow] = useState(false);
  useEffect(() => { const t = setTimeout(() => setShow(true), delay); return () => clearTimeout(t); }, [delay]);
  return (
    <span className={`inline-block transition-all duration-700 ease-out ${show ? 'opacity-100 translate-y-0 blur-0' : 'opacity-0 translate-y-4 blur-sm'} ${className}`}>
      {children}
    </span>
  );
}

// ── Fade-in on scroll ────────────────────────────────────────────────────────
function useFadeIn() {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setVisible(true); observer.disconnect(); } },
      { threshold: 0.1 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, className: `transition-all duration-700 ease-out ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'}` };
}

function FadeIn({ children, delay = 0, className = '' }: { children: React.ReactNode; delay?: number; className?: string }) {
  const fade = useFadeIn();
  return (
    <div ref={fade.ref} className={`${fade.className} ${className}`} style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </div>
  );
}

// ── Live counter ────────────────────────────────────────────────────────────
function AnimatedNumber({ target, duration = 2000, suffix = '' }: { target: number; duration?: number; suffix?: string }) {
  const [value, setValue] = useState(0);
  const ref = useRef<HTMLSpanElement>(null);
  const started = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !started.current) {
        started.current = true;
        const start = Date.now();
        const tick = () => {
          const progress = Math.min((Date.now() - start) / duration, 1);
          const eased = 1 - Math.pow(1 - progress, 3);
          setValue(Math.floor(target * eased));
          if (progress < 1) requestAnimationFrame(tick);
        };
        tick();
      }
    }, { threshold: 0.5 });
    observer.observe(el);
    return () => observer.disconnect();
  }, [target, duration]);

  return <span ref={ref}>{value.toLocaleString()}{suffix}</span>;
}

// ── CLI Demo ─────────────────────────────────────────────────────────────────
const CLI_DEMOS: { cmd: string; desc: string; lines: { text: string; color?: string; delay?: number }[] }[] = [
  {
    cmd: 'init',
    desc: 'Setup in 30s',
    lines: [
      { text: '$ origin init', color: 'text-gray-200' },
      { text: '  Detecting AI agents...', color: 'text-gray-500', delay: 300 },
      { text: '  \u2713 Claude Code (claude-code)', color: 'text-emerald-400', delay: 600 },
      { text: '  \u2713 Cursor (cursor)', color: 'text-emerald-400', delay: 800 },
      { text: '  Installing git hooks...', color: 'text-gray-500', delay: 1100 },
      { text: '  \u2713 post-commit hook installed', color: 'text-emerald-400', delay: 1400 },
      { text: '  \u2713 Origin initialized in 2.1s', color: 'text-indigo-400', delay: 1800 },
    ],
  },
  {
    cmd: 'blame',
    desc: 'AI attribution',
    lines: [
      { text: '$ origin blame src/api.ts', color: 'text-gray-200' },
      { text: '  L12  \u2502 claude-4  \u2502 "add auth middleware"', color: 'text-blue-400', delay: 400 },
      { text: '  L13  \u2502 claude-4  \u2502 "add auth middleware"', color: 'text-blue-400', delay: 500 },
      { text: '  L14  \u2502 human     \u2502                      ', color: 'text-gray-500', delay: 600 },
      { text: '  L15  \u2502 cursor    \u2502 "refactor error handler"', color: 'text-amber-400', delay: 700 },
      { text: '  L16  \u2502 cursor    \u2502 "refactor error handler"', color: 'text-amber-400', delay: 800 },
      { text: '  L17  \u2502 gemini    \u2502 "add rate limiting"', color: 'text-purple-400', delay: 900 },
    ],
  },
  {
    cmd: 'sessions',
    desc: 'Track sessions',
    lines: [
      { text: '$ origin sessions', color: 'text-gray-200' },
      { text: '  ID       Agent      Cost    Duration  Status', color: 'text-gray-600', delay: 300 },
      { text: '  a3f2..   claude-4   $0.42   3m 12s    ended', color: 'text-gray-400', delay: 500 },
      { text: '  b7e1..   cursor     $0.18   1m 45s    ended', color: 'text-gray-400', delay: 600 },
      { text: '  c9d4..   gemini     $0.31   2m 08s    ended', color: 'text-gray-400', delay: 700 },
      { text: '  d1a8..   claude-4   $0.67   5m 22s    running', color: 'text-emerald-400', delay: 800 },
      { text: '  Total: 4 sessions, $1.58 today', color: 'text-indigo-400', delay: 1100 },
    ],
  },
  {
    cmd: 'stats',
    desc: 'Cost & usage',
    lines: [
      { text: '$ origin stats --week', color: 'text-gray-200' },
      { text: '  Sessions: 47    Cost: $12.30', color: 'text-gray-400', delay: 400 },
      { text: '  Tokens:   1.2M  Lines: +3,241 / -892', color: 'text-gray-400', delay: 600 },
      { text: '  Top model:   claude-4-sonnet (62%)', color: 'text-blue-400', delay: 800 },
      { text: '  Top agent:   claude-code (34 sessions)', color: 'text-amber-400', delay: 1000 },
      { text: '  Streak:      12 days', color: 'text-emerald-400', delay: 1200 },
    ],
  },
  {
    cmd: 'explain',
    desc: 'Session replay',
    lines: [
      { text: '$ origin explain a3f2', color: 'text-gray-200' },
      { text: '  Session a3f2.. | claude-4 | 3m 12s', color: 'text-gray-600', delay: 400 },
      { text: '  Turn 1: "add user authentication"', color: 'text-gray-400', delay: 700 },
      { text: '    > auth.ts, middleware.ts (+48 lines)', color: 'text-emerald-400', delay: 900 },
      { text: '  Turn 2: "add rate limiting"', color: 'text-gray-400', delay: 1200 },
      { text: '    > rateLimit.ts, api.ts (+23 lines)', color: 'text-emerald-400', delay: 1400 },
      { text: '  Turn 3: "write tests"', color: 'text-gray-400', delay: 1700 },
      { text: '    > auth.test.ts (+67 lines)', color: 'text-emerald-400', delay: 1900 },
    ],
  },
];

function CliDemo() {
  const [active, setActive] = useState(0);
  const [visibleLines, setVisibleLines] = useState(1);
  const demo = CLI_DEMOS[active];

  useEffect(() => {
    const timer = setInterval(() => setActive((p) => (p + 1) % CLI_DEMOS.length), 5000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    setVisibleLines(1);
    const timers: ReturnType<typeof setTimeout>[] = [];
    demo.lines.forEach((line, i) => {
      if (i === 0) return;
      if (line.delay) timers.push(setTimeout(() => setVisibleLines((v) => Math.max(v, i + 1)), line.delay));
    });
    return () => timers.forEach(clearTimeout);
  }, [active]);

  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex gap-1 mb-2">
        {CLI_DEMOS.map((c, i) => (
          <button
            key={c.cmd}
            onClick={() => setActive(i)}
            className={`flex-1 py-1.5 text-center text-xs font-mono rounded transition-all duration-200 ${
              i === active
                ? 'text-indigo-400 bg-indigo-500/8 border border-indigo-500/20'
                : 'text-gray-600 border border-transparent hover:text-gray-400'
            }`}
          >
            <span className="block">{c.cmd}</span>
            <span className={`block text-[10px] ${i === active ? 'text-gray-400' : 'text-gray-700'}`}>{c.desc}</span>
          </button>
        ))}
      </div>
      <div className="bg-[rgb(10,10,12)] border border-gray-800/60 rounded-lg overflow-hidden shadow-2xl shadow-black/50">
        <div className="flex items-center gap-1.5 px-3 py-2 border-b border-white/[0.04]">
          <div className="w-2.5 h-2.5 rounded-full bg-[#ff5f57]" />
          <div className="w-2.5 h-2.5 rounded-full bg-[#febc2e]" />
          <div className="w-2.5 h-2.5 rounded-full bg-[#28c840]" />
          <span className="ml-2 text-[11px] text-gray-600 font-mono">terminal</span>
        </div>
        <div className="px-4 py-3 font-mono text-[13px] leading-relaxed h-[185px]">
          {demo.lines.slice(0, visibleLines).map((line, i) => (
            <div key={`${active}-${i}`} className={`${line.color || 'text-gray-500'}`}>{line.text}</div>
          ))}
          {visibleLines < demo.lines.length && (
            <span className="inline-block w-1.5 h-3.5 bg-indigo-400/50 animate-pulse" />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Install command ──────────────────────────────────────────────────────────
const INSTALL_CMD = 'npm i -g https://getorigin.io/cli/origin-cli-latest.tgz';
const INSTALL_DISPLAY = 'npm i -g origin-cli';

function InstallCommand() {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(INSTALL_CMD);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="max-w-xl mx-auto mt-8">
      <button
        onClick={handleCopy}
        className="inline-flex items-center gap-3 bg-[rgb(10,10,12)] border border-gray-800/60 rounded-lg px-4 py-3 text-left group hover:border-indigo-500/30 transition-colors"
      >
        <span className="text-xs text-gray-500 shrink-0">Get started in seconds:</span>
        <span className="text-indigo-400 text-xs font-mono">$</span>
        <code className="text-sm font-mono text-gray-400">{INSTALL_DISPLAY}</code>
        <span className="animate-pulse text-indigo-400 font-mono text-sm">&#9646;</span>
        <span className="text-xs text-gray-600 group-hover:text-gray-400 transition-colors shrink-0">
          {copied ? 'Copied!' : 'Copy'}
        </span>
      </button>
    </div>
  );
}

// ── Agents ───────────────────────────────────────────────────────────────────
const AGENTS = [
  { name: 'Claude Code', color: 'text-purple-400' },
  { name: 'Cursor', color: 'text-blue-400' },
  { name: 'Gemini CLI', color: 'text-amber-400' },
  { name: 'Codex', color: 'text-green-400' },
  { name: 'Copilot', color: 'text-gray-500', soon: true },
  { name: 'Windsurf', color: 'text-gray-500', soon: true },
];

// ── Main ─────────────────────────────────────────────────────────────────────
export default function Landing() {
  return (
    <>
      <Helmet>
        <title>Origin — AI Code Attribution & Governance</title>
        <meta name="description" content="Origin tracks every AI coding session, attributes every line, and gives you full visibility into AI-generated code. Free for solo developers." />
        <link rel="canonical" href="https://getorigin.io" />
      </Helmet>

      <style>{`
        .aurora-blob {
          position: absolute;
          border-radius: 50%;
          filter: blur(80px);
          opacity: 0.07;
          will-change: transform;
        }
        .aurora-1 {
          width: 600px; height: 600px;
          background: linear-gradient(135deg, #6366f1, #a855f7);
          top: -200px; left: -100px;
          animation: drift1 20s ease-in-out infinite;
        }
        .aurora-2 {
          width: 500px; height: 500px;
          background: linear-gradient(135deg, #38bdf8, #6366f1);
          top: -100px; right: -150px;
          animation: drift2 25s ease-in-out infinite;
        }
        .aurora-3 {
          width: 400px; height: 400px;
          background: linear-gradient(135deg, #10b981, #38bdf8);
          bottom: -150px; left: 30%;
          animation: drift3 22s ease-in-out infinite;
        }
        @keyframes drift1 {
          0%, 100% { transform: translate(0, 0) scale(1); }
          33% { transform: translate(80px, 40px) scale(1.1); }
          66% { transform: translate(-40px, 60px) scale(0.95); }
        }
        @keyframes drift2 {
          0%, 100% { transform: translate(0, 0) scale(1); }
          33% { transform: translate(-60px, 50px) scale(0.9); }
          66% { transform: translate(40px, -30px) scale(1.1); }
        }
        @keyframes drift3 {
          0%, 100% { transform: translate(0, 0) scale(1); }
          33% { transform: translate(50px, -40px) scale(1.15); }
          66% { transform: translate(-70px, 20px) scale(0.9); }
        }
        @keyframes shimmer {
          0% { background-position: -200% center; }
          100% { background-position: 200% center; }
        }
        .text-shimmer {
          background: linear-gradient(90deg, #6366f1 0%, #a855f7 25%, #38bdf8 50%, #a855f7 75%, #6366f1 100%);
          background-size: 200% auto;
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          animation: shimmer 6s linear infinite;
        }
        @keyframes scan {
          0% { transform: translateY(-100%); opacity: 0; }
          10% { opacity: 1; }
          90% { opacity: 1; }
          100% { transform: translateY(100%); opacity: 0; }
        }
        .scan-line {
          animation: scan 3s ease-in-out infinite;
        }
      `}</style>

      {/* ─── HERO ─────────────────────────────────────────────────────────── */}
      <section className="relative min-h-[85vh] flex items-center overflow-hidden">
        <AuroraBackground />
        <Particles />

        {/* Scan line effect */}
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          <div className="scan-line absolute left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-indigo-500/30 to-transparent" />
        </div>

        <div className="relative w-full max-w-5xl mx-auto px-6 py-20">
          <div className="max-w-3xl">
            {/* Badge */}
            <RevealText delay={200}>
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-white/[0.08] bg-white/[0.03] mb-8 backdrop-blur-sm">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                <span className="text-xs text-gray-400">AI Code Attribution & Governance</span>
              </div>
            </RevealText>

            <h1 className="text-[clamp(2.8rem,7vw,5rem)] font-bold leading-[1.0] tracking-[-0.04em]">
              <RevealText delay={400}>
                <span className="text-white">Your AI agents build fast. </span>
                <span className="text-shimmer">Origin keeps them in check.</span>
              </RevealText>
            </h1>

            <RevealText delay={1400}>
              <p className="mt-8 text-lg text-gray-400 max-w-lg leading-relaxed">
                Track every AI coding session. See which agent wrote what, how much it cost,
                and what changed.{' '}
                <span className="text-emerald-400/90">Free for solo developers.</span>
              </p>
            </RevealText>

            <RevealText delay={1700}>
              <div className="mt-10 flex items-center gap-4">
                <Link
                  to="/register?type=developer"
                  className="group relative px-7 py-3 text-sm font-medium rounded-lg bg-indigo-600 text-white overflow-hidden transition-all hover:shadow-lg hover:shadow-indigo-500/25"
                >
                  <span className="relative z-10">Get started free &rarr;</span>
                  <div className="absolute inset-0 bg-gradient-to-r from-indigo-600 via-purple-600 to-indigo-600 opacity-0 group-hover:opacity-100 transition-opacity" />
                </Link>
                <Link
                  to="/pricing"
                  className="px-7 py-3 text-sm font-medium rounded-lg text-gray-300 border border-white/[0.1] hover:bg-white/[0.05] hover:border-white/[0.15] transition-all"
                >
                  View plans
                </Link>
                <a
                  href="https://github.com/dolobanko/origin-cli"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 px-5 py-3 text-sm font-medium rounded-lg text-gray-400 border border-white/[0.1] hover:bg-white/[0.05] hover:border-white/[0.15] hover:text-white transition-all"
                >
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
                  GitHub
                </a>
              </div>

              {/* Install one-liner */}
              <div className="mt-6 max-w-xl">
                <InstallCommand />
              </div>
            </RevealText>

            {/* Agent pills */}
            <RevealText delay={2000}>
              <div className="mt-14 flex items-center gap-3 flex-wrap">
                <span className="text-[11px] text-gray-600 uppercase tracking-wider mr-1">Works with</span>
                {AGENTS.map((a) => (
                  <span
                    key={a.name}
                    className={`text-[11px] font-medium px-2.5 py-1 rounded-full border border-white/[0.06] bg-white/[0.02] ${a.color} ${a.soon ? 'opacity-30' : ''}`}
                  >
                    {a.name}
                  </span>
                ))}
              </div>
            </RevealText>
          </div>

          {/* Side stat counters */}
          <div className="hidden lg:flex absolute right-6 top-1/2 -translate-y-1/2 flex-col gap-8 items-end">
            <RevealText delay={2200}>
              <div className="text-right">
                <div className="text-3xl font-bold text-white tabular-nums"><AnimatedNumber target={4} />+</div>
                <div className="text-[11px] text-gray-600 uppercase tracking-wider">AI agents</div>
              </div>
            </RevealText>
            <RevealText delay={2400}>
              <div className="text-right">
                <div className="text-3xl font-bold text-white tabular-nums"><AnimatedNumber target={50} />+</div>
                <div className="text-[11px] text-gray-600 uppercase tracking-wider">CLI commands</div>
              </div>
            </RevealText>
            <RevealText delay={2600}>
              <div className="text-right">
                <div className="text-3xl font-bold text-emerald-400 tabular-nums">$0</div>
                <div className="text-[11px] text-gray-600 uppercase tracking-wider">Solo plan</div>
              </div>
            </RevealText>
          </div>
        </div>
      </section>

      <div className="border-t border-white/[0.06]" />

      {/* ─── CLI DEMO ─────────────────────────────────────────────────────── */}
      <section className="max-w-4xl mx-auto px-6 py-24">
        <FadeIn>
          <div className="flex items-end justify-between mb-8">
            <div>
              <p className="text-xs text-gray-600 font-mono mb-2">1.0</p>
              <h2 className="text-3xl font-semibold text-gray-100 tracking-[-0.02em]">Five commands,<br />full visibility</h2>
            </div>
            <p className="text-sm text-gray-500 max-w-xs text-right hidden sm:block">
              Install the CLI and run <code className="text-indigo-400/80">origin init</code>. Everything is tracked from your first commit.
            </p>
          </div>
          <CliDemo />
        </FadeIn>
      </section>

      {/* ─── VIDEO ────────────────────────────────────────────────────────── */}
      <section className="max-w-4xl mx-auto px-6 pb-24">
        <FadeIn>
          <div className="rounded-lg overflow-hidden border border-white/[0.06] shadow-2xl shadow-black/40">
            <div style={{ position: 'relative', paddingBottom: '56.25%', height: 0 }}>
              <iframe
                src="https://www.loom.com/embed/9916f9b26b5142b399f8e6822bc2ca02?sid=auto&hide_owner=true&hide_share=true&hide_title=true&hideEmbedTopBar=true"
                frameBorder="0"
                allowFullScreen
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}
              />
            </div>
          </div>
        </FadeIn>
      </section>

      <div className="border-t border-white/[0.06]" />

      {/* ─── FEATURES ─────────────────────────────────────────────────────── */}
      <section className="max-w-5xl mx-auto px-6 py-24">
        <FadeIn>
          <div className="flex items-end justify-between mb-16">
            <div>
              <p className="text-xs text-gray-600 font-mono mb-2">2.0</p>
              <h2 className="text-3xl font-semibold text-gray-100 tracking-[-0.02em]">Everything recorded.<br />Nothing lost.</h2>
            </div>
            <p className="text-sm text-gray-500 max-w-xs text-right hidden sm:block">
              From line-level attribution to real-time policy enforcement.
            </p>
          </div>
        </FadeIn>

        <div className="grid md:grid-cols-2 gap-px bg-white/[0.04] rounded-lg overflow-hidden border border-white/[0.06]">
          {[
            { title: 'AI Blame', desc: 'See which AI agent wrote each line of code, what prompt generated it, and the full session it came from.', label: '2.1', accent: 'text-indigo-400' },
            { title: 'Session Replay', desc: 'Every prompt, response, tool call, and file change — recorded with timestamps, token counts, and costs.', label: '2.2', accent: 'text-purple-400' },
            { title: 'Cost Tracking', desc: 'Track spend per agent, model, repo, and developer. Set budgets. See which models deliver the best ROI.', label: '2.3', accent: 'text-amber-400' },
            { title: 'Live Dashboard', desc: 'Watch AI sessions in real-time. See active agents, tokens burned, cost per session, and stop runaway agents.', label: '2.4', accent: 'text-emerald-400' },
            { title: 'Policy Enforcement', desc: 'Block secrets, enforce file restrictions, set cost limits, require human review. Evaluate in real-time.', label: '2.5', accent: 'text-cyan-400' },
            { title: 'Attribution Context', desc: 'When an agent opens a file, Origin injects line-level authorship — so every AI knows what others changed.', label: '2.6', accent: 'text-rose-400' },
          ].map((f, i) => (
            <FadeIn key={f.label} delay={i * 80}>
              <div className="bg-[rgb(8,9,10)] p-8 h-full group hover:bg-white/[0.02] transition-colors duration-200">
                <div className="flex items-center gap-3 mb-4">
                  <span className="text-xs text-gray-700 font-mono">{f.label}</span>
                  <h3 className={`text-base font-semibold ${f.accent}`}>{f.title}</h3>
                </div>
                <p className="text-sm text-gray-500 leading-relaxed">{f.desc}</p>
              </div>
            </FadeIn>
          ))}
        </div>
      </section>

      <div className="border-t border-white/[0.06]" />

      {/* ─── HOW IT WORKS ─────────────────────────────────────────────────── */}
      <section className="max-w-5xl mx-auto px-6 py-24">
        <FadeIn>
          <div className="flex items-end justify-between mb-16">
            <div>
              <p className="text-xs text-gray-600 font-mono mb-2">3.0</p>
              <h2 className="text-3xl font-semibold text-gray-100 tracking-[-0.02em]">From code to merge,<br />fully tracked</h2>
            </div>
            <p className="text-sm text-gray-500 max-w-xs text-right hidden sm:block">
              Origin works silently in the background. No workflow changes required.
            </p>
          </div>
        </FadeIn>

        <div className="space-y-0">
          {[
            { step: '01', title: 'Code with AI', desc: 'Use Claude, Cursor, Codex, or Gemini. Origin hooks capture everything automatically.' },
            { step: '02', title: 'Capture & attribute', desc: 'Every prompt, file change, and token is recorded. Per-line attribution tags each author.' },
            { step: '03', title: 'Enforce policies', desc: 'File restrictions, blocked patterns, model allowlists, and cost limits evaluate in real-time.' },
            { step: '04', title: 'PR governance', desc: 'Status check on the pull request shows sessions, cost, and policy violations.' },
            { step: '05', title: 'Review & ship', desc: 'Review flagged sessions in dashboard or CLI. Approve, and the PR merges with full audit trail.' },
          ].map((s, i) => (
            <FadeIn key={s.step} delay={i * 60}>
              <div className="flex items-start gap-6 py-6 border-t border-white/[0.06] group">
                <span className="text-xs font-mono text-gray-700 pt-0.5 w-6 shrink-0">{s.step}</span>
                <div className="flex-1 flex items-start justify-between gap-8">
                  <h3 className="text-base font-medium text-gray-200 w-48 shrink-0">{s.title}</h3>
                  <p className="text-sm text-gray-500 leading-relaxed">{s.desc}</p>
                </div>
              </div>
            </FadeIn>
          ))}
        </div>
      </section>

      <div className="border-t border-white/[0.06]" />

      {/* ─── SOLO vs TEAM ─────────────────────────────────────────────────── */}
      <section className="max-w-5xl mx-auto px-6 py-24">
        <FadeIn>
          <div className="flex items-end justify-between mb-16">
            <div>
              <p className="text-xs text-gray-600 font-mono mb-2">4.0</p>
              <h2 className="text-3xl font-semibold text-gray-100 tracking-[-0.02em]">Two modes,<br />one platform</h2>
            </div>
            <p className="text-sm text-gray-500 max-w-xs text-right hidden sm:block">
              Solo is free forever. Team adds governance. Use both at the same time.
            </p>
          </div>
        </FadeIn>

        <div className="grid md:grid-cols-2 gap-6">
          <FadeIn>
            <div className="border border-emerald-500/30 rounded-xl p-8 bg-gradient-to-b from-emerald-500/[0.08] to-emerald-500/[0.02] h-full shadow-lg shadow-emerald-500/5">
              <div className="flex items-center gap-3 mb-2">
                <span className="text-xs font-mono text-gray-700">4.1</span>
                <h3 className="text-lg font-semibold text-gray-100">Origin Solo</h3>
                <span className="text-xs text-emerald-400 font-medium">Free</span>
              </div>
              <p className="text-sm text-gray-500 mb-6">Your personal AI coding dashboard.</p>
              <div className="space-y-3 text-sm text-gray-400">
                {['Unlimited repos, sessions, and agents', 'Full session replay with prompts and diffs', 'Token usage and cost tracking per model', 'CLI tools \u2014 blame, stats, diff, prompts', 'Works with Claude, Gemini, Codex, Cursor'].map((item) => (
                  <div key={item} className="flex items-start gap-2.5"><span className="text-emerald-400/60 mt-0.5 text-xs">+</span>{item}</div>
                ))}
              </div>
              <div className="mt-8">
                <Link to="/register?type=developer" className="text-sm text-emerald-400 hover:text-emerald-300 transition-colors">Get free account &rarr;</Link>
              </div>
            </div>
          </FadeIn>

          <FadeIn delay={100}>
            <div className="border border-indigo-500/30 rounded-xl p-8 bg-gradient-to-b from-indigo-500/[0.08] to-indigo-500/[0.02] h-full shadow-lg shadow-indigo-500/5">
              <div className="flex items-center gap-3 mb-2">
                <span className="text-xs font-mono text-gray-700">4.2</span>
                <h3 className="text-lg font-semibold text-gray-100">Origin Team</h3>
                <span className="text-xs text-indigo-400 font-medium">$29/user/mo</span>
              </div>
              <p className="text-sm text-gray-500 mb-6">Governance for engineering teams.</p>
              <div className="space-y-3 text-sm text-gray-400">
                {['Everything in Solo, plus:', 'Centralized team dashboard \u2014 all sessions', 'Policy enforcement \u2014 model, cost, file limits', 'GitHub & GitLab PR checks and merge gating', 'Audit logs, compliance reports, Slack alerts'].map((item, i) => (
                  <div key={item} className="flex items-start gap-2.5"><span className="text-indigo-400/60 mt-0.5 text-xs">{i === 0 ? '~' : '+'}</span>{item}</div>
                ))}
              </div>
              <div className="mt-8">
                <Link to="/register?type=org" className="text-sm text-indigo-400 hover:text-indigo-300 transition-colors">Start 14-day trial &rarr;</Link>
              </div>
            </div>
          </FadeIn>
        </div>
      </section>

      <div className="border-t border-white/[0.06]" />

      {/* ─── COMPARISON ───────────────────────────────────────────────────── */}
      <section className="max-w-5xl mx-auto px-6 py-24">
        <FadeIn>
          <div className="text-center mb-14">
            <p className="text-xs text-gray-600 font-mono mb-2">5.0</p>
            <h2 className="text-3xl font-semibold text-gray-100 tracking-[-0.02em]">How Origin compares</h2>
            <p className="text-gray-500 mt-3 text-sm">The only platform that covers attribution, governance, and developer experience.</p>
          </div>
        </FadeIn>

        <FadeIn delay={100}>
          <div className="grid grid-cols-3 gap-5">
            {/* Origin — highlighted */}
            <div className="relative rounded-xl border border-indigo-500/30 bg-gradient-to-b from-indigo-500/[0.06] to-transparent p-6 overflow-hidden">
              <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-indigo-400/60 to-transparent" />
              <div className="flex items-center gap-2.5 mb-5">
                <LogoMark size={28} />
                <span className="font-semibold text-gray-100">Origin</span>
              </div>
              <div className="space-y-3">
                {[
                  'Session recording & replay',
                  'AI blame (line-level)',
                  'Multi-agent support (5+)',
                  'Policy enforcement',
                  'Secret & credential scanning',
                  'PR/MR merge gating',
                  'Budget controls',
                  'Cross-agent context',
                  'Compliance audit trail',
                  'Rework & churn detection',
                ].map((f, i) => (
                  <div key={i} className="flex items-center gap-2.5">
                    <div className="w-5 h-5 rounded-full bg-indigo-500/20 flex items-center justify-center shrink-0">
                      <svg className="w-3 h-3 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                    </div>
                    <span className="text-sm text-gray-300">{f}</span>
                  </div>
                ))}
              </div>
              <div className="mt-6 pt-4 border-t border-white/[0.06]">
                <span className="text-xs text-indigo-400 font-medium">10 / 10</span>
              </div>
            </div>

            {/* Entire */}
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.015] p-6">
              <div className="flex items-center gap-2.5 mb-5">
                <div className="w-7 h-7 rounded-lg bg-gray-800 flex items-center justify-center text-gray-500 text-xs font-bold">E</div>
                <span className="font-semibold text-gray-400">Entire</span>
              </div>
              <div className="space-y-3">
                {[
                  [true,  'Session recording & replay'],
                  [false, 'AI blame (line-level)'],
                  [true,  'Multi-agent support'],
                  [false, 'Policy enforcement'],
                  [false, 'Secret & credential scanning'],
                  [false, 'PR/MR merge gating'],
                  [false, 'Budget controls'],
                  [false, 'Cross-agent context'],
                  [false, 'Compliance audit trail'],
                  [false, 'Rework & churn detection'],
                ].map(([has, label], i) => (
                  <div key={i} className="flex items-center gap-2.5">
                    {has ? (
                      <div className="w-5 h-5 rounded-full bg-gray-700/50 flex items-center justify-center shrink-0">
                        <svg className="w-3 h-3 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                      </div>
                    ) : (
                      <div className="w-5 h-5 rounded-full bg-gray-800/50 flex items-center justify-center shrink-0">
                        <div className="w-1.5 h-px bg-gray-700" />
                      </div>
                    )}
                    <span className={`text-sm ${has ? 'text-gray-400' : 'text-gray-600'}`}>{label as string}</span>
                  </div>
                ))}
              </div>
              <div className="mt-6 pt-4 border-t border-white/[0.06]">
                <span className="text-xs text-gray-500">2 / 10</span>
              </div>
            </div>

            {/* git-ai */}
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.015] p-6">
              <div className="flex items-center gap-2.5 mb-5">
                <div className="w-7 h-7 rounded-lg bg-gray-800 flex items-center justify-center text-gray-500 text-xs font-bold">G</div>
                <span className="font-semibold text-gray-400">git-ai</span>
              </div>
              <div className="space-y-3">
                {[
                  [false, 'Session recording & replay'],
                  [true,  'AI blame (line-level)'],
                  [true,  'Multi-agent support'],
                  [false, 'Policy enforcement'],
                  [false, 'Secret & credential scanning'],
                  [false, 'PR/MR merge gating'],
                  [false, 'Budget controls'],
                  [false, 'Cross-agent context'],
                  [false, 'Compliance audit trail'],
                  [false, 'Rework & churn detection'],
                ].map(([has, label], i) => (
                  <div key={i} className="flex items-center gap-2.5">
                    {has ? (
                      <div className="w-5 h-5 rounded-full bg-gray-700/50 flex items-center justify-center shrink-0">
                        <svg className="w-3 h-3 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                      </div>
                    ) : (
                      <div className="w-5 h-5 rounded-full bg-gray-800/50 flex items-center justify-center shrink-0">
                        <div className="w-1.5 h-px bg-gray-700" />
                      </div>
                    )}
                    <span className={`text-sm ${has ? 'text-gray-400' : 'text-gray-600'}`}>{label as string}</span>
                  </div>
                ))}
              </div>
              <div className="mt-6 pt-4 border-t border-white/[0.06]">
                <span className="text-xs text-gray-500">2 / 10</span>
              </div>
            </div>
          </div>
        </FadeIn>
      </section>

      <div className="border-t border-white/[0.06]" />

      {/* ─── CTA ──────────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 pointer-events-none">
          <div className="aurora-blob" style={{ width: 500, height: 500, background: 'linear-gradient(135deg, #6366f1, #a855f7)', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', filter: 'blur(100px)', opacity: 0.05 }} />
        </div>

        <div className="relative max-w-3xl mx-auto px-6 py-28 text-center">
          <FadeIn>
            <h2 className="text-4xl font-bold text-gray-100 tracking-[-0.02em] mb-4">
              Get started in 30 seconds
            </h2>
            <p className="text-gray-500 mb-10 max-w-md mx-auto text-lg">
              Install the CLI and run <code className="text-indigo-400/70">origin init</code>. Solo is free forever.
            </p>

            <InstallCommand />

            <div className="mt-10 flex items-center justify-center gap-4">
              <Link
                to="/register?type=developer"
                className="group relative px-8 py-3 text-sm font-medium rounded-lg bg-indigo-600 text-white overflow-hidden transition-all hover:shadow-lg hover:shadow-indigo-500/25"
              >
                <span className="relative z-10">Start free &rarr;</span>
                <div className="absolute inset-0 bg-gradient-to-r from-indigo-600 via-purple-600 to-indigo-600 opacity-0 group-hover:opacity-100 transition-opacity" />
              </Link>
              <Link
                to="/register?type=org"
                className="px-8 py-3 text-sm font-medium rounded-lg text-gray-300 border border-white/[0.1] hover:bg-white/[0.05] hover:border-white/[0.15] transition-all"
              >
                Team trial &rarr;
              </Link>
            </div>
          </FadeIn>
        </div>
      </section>
    </>
  );
}
