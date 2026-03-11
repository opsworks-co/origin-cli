import chalk from 'chalk';
import fs from 'fs';
import { getAllPrompts, getPromptCount, type PromptRecord } from '../local-db.js';

// ─── Types ────────────────────────────────────────────────────────────────

interface AnalysisResult {
  totalPrompts: number;
  avgPromptLength: number;
  medianPromptLength: number;
  promptToFileRatio: number;
  modelBreakdown: Array<{ model: string; count: number; avgLength: number; pct: number }>;
  commonPatterns: Array<{ pattern: string; count: number }>;
  timeDistribution: Record<string, number>;
  topFiles: Array<{ file: string; count: number }>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Detect common prompt patterns (questions, commands, fixes, etc.)
 */
function detectPatterns(prompts: PromptRecord[]): Array<{ pattern: string; count: number }> {
  const patterns: Record<string, number> = {
    'bug fix / fix': 0,
    'add / create / implement': 0,
    'refactor / clean up': 0,
    'test / testing': 0,
    'update / modify / change': 0,
    'explain / describe': 0,
    'review / check': 0,
    'debug / investigate': 0,
    'docs / documentation': 0,
    'config / setup': 0,
  };

  const matchers: Array<[string, RegExp]> = [
    ['bug fix / fix', /\b(fix|bug|error|issue|broken|crash)\b/i],
    ['add / create / implement', /\b(add|create|implement|new|build|make)\b/i],
    ['refactor / clean up', /\b(refactor|clean|simplify|reorganize|restructure)\b/i],
    ['test / testing', /\b(test|spec|assert|expect|mock|stub)\b/i],
    ['update / modify / change', /\b(update|modify|change|adjust|tweak|edit)\b/i],
    ['explain / describe', /\b(explain|describe|what|how|why|understand)\b/i],
    ['review / check', /\b(review|check|verify|validate|audit|inspect)\b/i],
    ['debug / investigate', /\b(debug|investigate|trace|log|diagnose|troubleshoot)\b/i],
    ['docs / documentation', /\b(doc|documentation|readme|comment|annotate)\b/i],
    ['config / setup', /\b(config|setup|install|configure|env|setting)\b/i],
  ];

  for (const prompt of prompts) {
    const text = prompt.promptText;
    for (const [name, regex] of matchers) {
      if (regex.test(text)) {
        patterns[name]++;
      }
    }
  }

  return Object.entries(patterns)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([pattern, count]) => ({ pattern, count }));
}

/**
 * Compute time-of-day distribution.
 */
function timeDistribution(prompts: PromptRecord[]): Record<string, number> {
  const dist: Record<string, number> = {
    'morning (6-12)': 0,
    'afternoon (12-18)': 0,
    'evening (18-24)': 0,
    'night (0-6)': 0,
  };

  for (const p of prompts) {
    if (!p.timestamp) continue;
    const hour = new Date(p.timestamp).getHours();
    if (hour >= 6 && hour < 12) dist['morning (6-12)']++;
    else if (hour >= 12 && hour < 18) dist['afternoon (12-18)']++;
    else if (hour >= 18) dist['evening (18-24)']++;
    else dist['night (0-6)']++;
  }

  return dist;
}

function renderBar(value: number, max: number, width: number = 30): string {
  const filled = max > 0 ? Math.round((value / max) * width) : 0;
  const empty = width - filled;
  return chalk.cyan('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
}

function analyze(prompts: PromptRecord[]): AnalysisResult {
  const lengths = prompts.map(p => p.promptText.length);
  const avgLength = lengths.length > 0 ? Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length) : 0;
  const medLength = median(lengths);

  // Prompt to file ratio
  const totalFiles = prompts.reduce((sum, p) => sum + p.filesChanged.length, 0);
  const ratio = prompts.length > 0 ? parseFloat((totalFiles / prompts.length).toFixed(2)) : 0;

  // Model breakdown
  const byModel = new Map<string, { count: number; totalLength: number }>();
  for (const p of prompts) {
    const m = p.model || 'unknown';
    const existing = byModel.get(m) || { count: 0, totalLength: 0 };
    existing.count++;
    existing.totalLength += p.promptText.length;
    byModel.set(m, existing);
  }
  const modelBreakdown = Array.from(byModel.entries())
    .map(([model, data]) => ({
      model,
      count: data.count,
      avgLength: Math.round(data.totalLength / data.count),
      pct: prompts.length > 0 ? Math.round((data.count / prompts.length) * 100) : 0,
    }))
    .sort((a, b) => b.count - a.count);

  // Top files
  const fileCounts = new Map<string, number>();
  for (const p of prompts) {
    for (const f of p.filesChanged) {
      fileCounts.set(f, (fileCounts.get(f) || 0) + 1);
    }
  }
  const topFiles = Array.from(fileCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([file, count]) => ({ file, count }));

  return {
    totalPrompts: prompts.length,
    avgPromptLength: avgLength,
    medianPromptLength: medLength,
    promptToFileRatio: ratio,
    modelBreakdown,
    commonPatterns: detectPatterns(prompts),
    timeDistribution: timeDistribution(prompts),
    topFiles,
  };
}

// ─── Command ──────────────────────────────────────────────────────────────

/**
 * origin analyze [--days <n>] [--export <path>]
 *
 * Analyzes local prompt database for patterns, statistics, and insights.
 */
export async function analyzeCommand(
  opts?: { days?: string; export?: string },
): Promise<void> {
  const totalCount = getPromptCount();
  if (totalCount === 0) {
    console.log(chalk.gray('No prompts in local database. Run "origin db import" first.'));
    return;
  }

  // Filter by days
  const days = opts?.days ? parseInt(opts.days, 10) : undefined;
  let since: string | undefined;
  if (days) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    since = cutoff.toISOString();
  }

  const prompts = getAllPrompts({ since });
  if (prompts.length === 0) {
    console.log(chalk.gray(`No prompts found${days ? ` in the last ${days} days` : ''}.`));
    return;
  }

  const result = analyze(prompts);

  // Export if requested
  if (opts?.export) {
    const exportPath = opts.export;
    if (exportPath.endsWith('.json')) {
      fs.writeFileSync(exportPath, JSON.stringify(result, null, 2));
      console.log(chalk.green(`Analysis exported to ${exportPath}`));
    } else {
      // Export as markdown
      const md = buildMarkdownExport(result, days);
      fs.writeFileSync(exportPath, md);
      console.log(chalk.green(`Analysis exported to ${exportPath}`));
    }
    return;
  }

  // Pretty print
  console.log(chalk.bold('\n  Prompt Analysis\n'));
  if (days) {
    console.log(chalk.gray(`  Period: last ${days} days\n`));
  }

  console.log(`  ${chalk.gray('Total prompts:')}       ${chalk.white(String(result.totalPrompts))}`);
  console.log(`  ${chalk.gray('Avg prompt length:')}   ${chalk.white(String(result.avgPromptLength))} chars`);
  console.log(`  ${chalk.gray('Median length:')}       ${chalk.white(String(result.medianPromptLength))} chars`);
  console.log(`  ${chalk.gray('Prompt-to-file ratio:')} ${chalk.white(String(result.promptToFileRatio))} files/prompt`);

  // Model breakdown
  if (result.modelBreakdown.length > 0) {
    console.log(chalk.bold('\n  Model Breakdown\n'));
    const maxCount = Math.max(...result.modelBreakdown.map(m => m.count));
    for (const m of result.modelBreakdown) {
      const bar = renderBar(m.count, maxCount, 20);
      console.log(
        `  ${chalk.cyan(m.model.padEnd(24))} ${bar} ${chalk.white(String(m.count))} (${m.pct}%)  avg ${m.avgLength} chars`,
      );
    }
  }

  // Common patterns
  if (result.commonPatterns.length > 0) {
    console.log(chalk.bold('\n  Common Patterns\n'));
    const maxPattern = Math.max(...result.commonPatterns.map(p => p.count));
    for (const p of result.commonPatterns) {
      const bar = renderBar(p.count, maxPattern, 15);
      console.log(`  ${p.pattern.padEnd(30)} ${bar} ${chalk.white(String(p.count))}`);
    }
  }

  // Time distribution
  const timeDist = result.timeDistribution;
  const maxTime = Math.max(...Object.values(timeDist));
  if (maxTime > 0) {
    console.log(chalk.bold('\n  Time Distribution\n'));
    for (const [period, count] of Object.entries(timeDist)) {
      const bar = renderBar(count, maxTime, 20);
      console.log(`  ${period.padEnd(20)} ${bar} ${chalk.white(String(count))}`);
    }
  }

  // Top files
  if (result.topFiles.length > 0) {
    console.log(chalk.bold('\n  Most Changed Files\n'));
    for (const f of result.topFiles.slice(0, 8)) {
      console.log(`  ${chalk.white(String(f.count).padStart(4))}x  ${chalk.gray(f.file)}`);
    }
  }

  console.log('');
}

// ─── Export Helpers ───────────────────────────────────────────────────────

function buildMarkdownExport(result: AnalysisResult, days?: number): string {
  const lines: string[] = [];
  lines.push('# Prompt Analysis Report');
  lines.push('');
  if (days) lines.push(`Period: last ${days} days`);
  lines.push('');
  lines.push('## Overview');
  lines.push('');
  lines.push(`- Total prompts: ${result.totalPrompts}`);
  lines.push(`- Average prompt length: ${result.avgPromptLength} chars`);
  lines.push(`- Median prompt length: ${result.medianPromptLength} chars`);
  lines.push(`- Prompt-to-file ratio: ${result.promptToFileRatio}`);
  lines.push('');

  if (result.modelBreakdown.length > 0) {
    lines.push('## Model Breakdown');
    lines.push('');
    lines.push('| Model | Count | % | Avg Length |');
    lines.push('|-------|-------|---|------------|');
    for (const m of result.modelBreakdown) {
      lines.push(`| ${m.model} | ${m.count} | ${m.pct}% | ${m.avgLength} |`);
    }
    lines.push('');
  }

  if (result.commonPatterns.length > 0) {
    lines.push('## Common Patterns');
    lines.push('');
    for (const p of result.commonPatterns) {
      lines.push(`- ${p.pattern}: ${p.count}`);
    }
    lines.push('');
  }

  if (result.topFiles.length > 0) {
    lines.push('## Most Changed Files');
    lines.push('');
    for (const f of result.topFiles) {
      lines.push(`- ${f.file} (${f.count}x)`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
