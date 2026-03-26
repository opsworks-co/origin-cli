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
    title: 'Your AI agents need a manager. We built one.',
    slug: 'ai-agents-need-a-manager',
    date: '2026-03-26',
    author: 'Artem Dolobanko',
    tags: ['product', 'governance', 'engineering'],
    excerpt:
      'Your team runs Claude, Cursor, Gemini, and Codex across dozens of repos. Nobody knows which agent wrote what, what it cost, or whether it followed the rules. We built Origin to fix that.',
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
