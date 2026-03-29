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
