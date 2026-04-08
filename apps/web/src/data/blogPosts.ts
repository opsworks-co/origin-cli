export interface BlogPost {
  title: string;
  slug: string;
  date: string;
  author: string;
  tags: string[];
  excerpt: string;
  content: React.ReactNode;
}

// Content is rendered in BlogPost.tsx via the renderContent helper
export interface BlogPostData {
  title: string;
  slug: string;
  date: string;
  author: string;
  tags: string[];
  excerpt: string;
}

export const blogPosts: BlogPostData[] = [
  {
    title: 'Why We Built Origin: The New Era of Source Code Management for AI',
    slug: 'new-era-source-code-management-ai',
    date: '2026-04-08',
    author: 'Artem Dolobanko',
    tags: ['ai-governance', 'developer-tools', 'engineering-leadership', 'origin'],
    excerpt:
      'AI writes 30-70% of production code now, but git has no idea. Git blame shows the human who committed, not the AI that wrote it. We built Origin to fix that — line-level attribution, session replay, cost tracking, and governance for the AI coding era.',
  },
  {
    title: 'Multi-Repo Sessions: Track AI Coding Across Your Entire Workspace',
    slug: 'multi-repo-sessions',
    date: '2026-04-07',
    author: 'Artem Dolobanko',
    tags: ['developer-tools', 'solo', 'ai-coding', 'open-source', 'productivity'],
    excerpt:
      'Working in a monorepo or multi-project workspace? Origin now detects all git repos under your working directory and tracks changes across all of them in a single session. No config needed.',
  },
  {
    title: 'Merge Sessions & Commits Tab: See the Full Picture of Your AI Coding',
    slug: 'merge-sessions',
    date: '2026-04-05',
    author: 'Artem Dolobanko',
    tags: ['developer-tools', 'solo', 'ai-coding', 'productivity', 'commits'],
    excerpt:
      'Two new features: Merge Sessions combines multiple AI sessions into one unified view. The Commits tab shows every commit with AI/human attribution, linked sessions, cost, and which agent wrote the code.',
  },
  {
    title: 'Origin Solo: Free AI Coding Analytics for Individual Developers',
    slug: 'origin-solo-free-ai-coding-analytics',
    date: '2026-04-04',
    author: 'Artem Dolobanko',
    tags: ['developer-tools', 'solo', 'ai-coding', 'open-source'],
    excerpt:
      'You use Claude, Cursor, Gemini, and Codex every day — but you have no idea how much they cost, which one writes better code, or where your time goes. Origin Solo changes that. Free forever.',
  },
  {
    title: 'Shadow AI Is Your Biggest Engineering Blind Spot — Here\'s How to Fix It',
    slug: 'shadow-ai-engineering-blind-spot',
    date: '2026-04-02',
    author: 'Artem Dolobanko',
    tags: ['security', 'governance', 'enterprise', 'shadow-ai'],
    excerpt:
      'Most engineering teams have no idea what AI coding tools their developers use, what data those tools access, or what code they produce. This invisible risk — shadow AI — is the fastest-growing security gap in enterprise software development.',
  },
  {
    title: 'Your AI agents now remember what happened last session. Here\'s how cross-agent handoff works.',
    slug: 'cross-agent-handoff-session-memory',
    date: '2026-03-31',
    author: 'Artem Dolobanko',
    tags: ['developer-tools', 'ai-coding', 'open-source'],
    excerpt:
      'Switch from Claude to Cursor mid-task without losing context. Origin now saves what you were working on and injects it into the next agent\'s session — automatically. Plus session memory, AI TODO tracking, and more.',
  },
  {
    title: 'Your AI agents now follow company rules. Here\'s how we enforce policies across Cursor, Codex, and Claude.',
    slug: 'ai-governance-policies-ci',
    date: '2026-03-29',
    author: 'Artem Dolobanko',
    tags: ['governance', 'security', 'ci-cd'],
    excerpt:
      'We shipped cross-agent policy enforcement, CI/CD tamper detection, and native rules injection for Cursor and Codex. Your AI agents now follow the same rules your developers do.',
  },
  {
    title: 'We tested 4 AI agents on the same repo. Here\'s which one writes code that sticks.',
    slug: 'ai-agent-rework-rates',
    date: '2026-03-26',
    author: 'Artem Dolobanko',
    tags: ['engineering', 'benchmarks', 'ai-coding'],
    excerpt:
      'We ran Claude, Gemini, Cursor, and Codex on the same codebase for two weeks. Then we measured how much of each agent\'s code got rewritten. The results were not close.',
  },
  {
    title: 'Why git blame is broken in the age of AI coding',
    slug: 'why-git-blame-is-broken',
    date: '2026-03-25',
    author: 'Artem Dolobanko',
    tags: ['engineering', 'ai-coding', 'open-source'],
    excerpt:
      'Every developer uses git blame. But when 60%+ of code is AI-generated, git blame shows the wrong person. Here\'s why that matters and what we built to fix it.',
  },
];
