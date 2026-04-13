import { Router, Request, Response } from 'express';
import { blogPosts } from '../data/blog-posts.js';

const router = Router();

const SITE_URL = 'https://getorigin.io';
const FEED_TITLE = 'Origin Blog';
const FEED_DESCRIPTION =
  'AI governance, developer tools, and engineering leadership insights from Origin.';

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Convert "YYYY-MM-DD" to RFC 822 date string */
function toRfc822(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00Z');
  return d.toUTCString();
}

function generateRss(): string {
  const items = blogPosts
    .map((post) => {
      const link = `${SITE_URL}/blog/${post.slug}`;
      return `    <item>
      <title>${escapeXml(post.title)}</title>
      <link>${link}</link>
      <description>${escapeXml(post.excerpt)}</description>
      <pubDate>${toRfc822(post.date)}</pubDate>
      <guid isPermaLink="true">${link}</guid>
    </item>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(FEED_TITLE)}</title>
    <link>${SITE_URL}/blog</link>
    <description>${escapeXml(FEED_DESCRIPTION)}</description>
    <language>en-us</language>
    <atom:link href="${SITE_URL}/rss.xml" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>`;
}

const handler = (_req: Request, res: Response) => {
  const xml = generateRss();
  res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(xml);
};

router.get('/rss.xml', handler);
router.get('/feed.xml', handler);

export default router;
