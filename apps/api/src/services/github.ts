// GitHub API integration — supports public repos and private repos via GITHUB_TOKEN

interface GitHubCommit {
  sha: string;
  commit: {
    message: string;
    author: {
      name: string;
      date: string;
    };
  };
  files?: Array<{ filename: string }>;
}

interface GitHubContent {
  name: string;
  path: string;
  download_url: string | null;
  type: string;
}

/**
 * Parse a GitHub URL into owner/repo
 * Supports: https://github.com/owner/repo, github.com/owner/repo, owner/repo
 */
export function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  // Remove trailing slash and .git
  const cleaned = url.replace(/\/+$/, '').replace(/\.git$/, '');

  // Try full URL
  const urlMatch = cleaned.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (urlMatch) return { owner: urlMatch[1], repo: urlMatch[2] };

  // Try owner/repo format
  const shortMatch = cleaned.match(/^([^/]+)\/([^/]+)$/);
  if (shortMatch) return { owner: shortMatch[1], repo: shortMatch[2] };

  return null;
}

function getGitHubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'Origin-App',
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function ghFetch<T>(path: string): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: getGitHubHeaders(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API error: ${res.status} ${res.statusText} ${body}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Fetch commits from a GitHub repo (up to 100)
 */
export async function fetchGitHubCommits(
  owner: string,
  repo: string,
  perPage = 50
): Promise<Array<{ sha: string; message: string; author: string; date: string }>> {
  const commits = await ghFetch<GitHubCommit[]>(
    `/repos/${owner}/${repo}/commits?per_page=${perPage}`
  );
  return commits.map((c) => ({
    sha: c.sha,
    message: c.commit.message, // full message including trailers
    author: c.commit.author.name,
    date: c.commit.author.date,
  }));
}

/**
 * Check if .entire/ directory exists and list its snapshot files
 */
export async function fetchEntireSnapshots(
  owner: string,
  repo: string
): Promise<GitHubContent[]> {
  try {
    const contents = await ghFetch<GitHubContent[]>(
      `/repos/${owner}/${repo}/contents/.entire`
    );
    return contents.filter((f) => f.type === 'file' && f.name.endsWith('.json'));
  } catch {
    return []; // no .entire/ directory
  }
}

/**
 * Download a raw file from GitHub
 */
export async function fetchFileContent(downloadUrl: string): Promise<string> {
  const res = await fetch(downloadUrl, {
    headers: getGitHubHeaders(),
  });
  if (!res.ok) throw new Error(`Failed to fetch file: ${res.status}`);
  return res.text();
}
