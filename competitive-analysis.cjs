const fs = require("fs");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, HeadingLevel, BorderStyle, WidthType,
  ShadingType, PageNumber, PageBreak, LevelFormat, ExternalHyperlink,
  TableOfContents,
} = require("docx");

// ─── Colors ──────────────────────────────────────────────────────────────
const ORIGIN_BLUE = "1A5276";
const DARK_BLUE = "154360";
const LIGHT_BLUE = "D6EAF8";
const MID_BLUE = "2E86C1";
const ACCENT_GREEN = "27AE60";
const ACCENT_RED = "E74C3C";
const ACCENT_ORANGE = "F39C12";
const GRAY_BG = "F2F3F4";
const GRAY_TEXT = "5D6D7E";
const WHITE = "FFFFFF";
const BLACK = "1C2833";

// ─── Helpers ─────────────────────────────────────────────────────────────
const border = { style: BorderStyle.SINGLE, size: 1, color: "D5D8DC" };
const borders = { top: border, bottom: border, left: border, right: border };
const noBorder = { style: BorderStyle.NONE, size: 0, color: WHITE };
const noBorders = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder };

const TABLE_WIDTH = 9360;
const COL_WIDTHS = {
  feature: [2800, 1312, 1312, 1312, 1312, 1312],
  priority: [3200, 1200, 1200, 1880, 1880],
  twoCol: [4680, 4680],
};

function heading(text, level = HeadingLevel.HEADING_1) {
  return new Paragraph({ heading: level, spacing: { before: level === HeadingLevel.HEADING_1 ? 360 : 240, after: 200 }, children: [new TextRun({ text, bold: true, font: "Arial", color: ORIGIN_BLUE })] });
}

function body(text, opts = {}) {
  return new Paragraph({ spacing: { after: 120 }, alignment: opts.align, children: [new TextRun({ text, font: "Arial", size: 22, color: opts.color || BLACK, bold: opts.bold, italics: opts.italics })] });
}

function bulletItem(text, bold_prefix) {
  const children = [];
  if (bold_prefix) {
    children.push(new TextRun({ text: bold_prefix, font: "Arial", size: 22, bold: true, color: BLACK }));
    children.push(new TextRun({ text, font: "Arial", size: 22, color: BLACK }));
  } else {
    children.push(new TextRun({ text, font: "Arial", size: 22, color: BLACK }));
  }
  return new Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: 60 }, children });
}

function cell(text, opts = {}) {
  return new TableCell({
    borders,
    width: { size: opts.width || 1312, type: WidthType.DXA },
    shading: opts.shading ? { fill: opts.shading, type: ShadingType.CLEAR } : undefined,
    verticalAlign: "center",
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [new Paragraph({
      alignment: opts.align || AlignmentType.LEFT,
      children: [new TextRun({ text, font: "Arial", size: opts.size || 20, bold: opts.bold, color: opts.color || BLACK })]
    })]
  });
}

function headerCell(text, width) {
  return cell(text, { width, shading: ORIGIN_BLUE, color: WHITE, bold: true, size: 20 });
}

function checkCell(val, width) {
  // val: true = green check, false = red x, "partial" = orange ~
  if (val === true) return cell("\u2713", { width, color: ACCENT_GREEN, bold: true, align: AlignmentType.CENTER, size: 22 });
  if (val === "partial") return cell("~", { width, color: ACCENT_ORANGE, bold: true, align: AlignmentType.CENTER, size: 22 });
  return cell("\u2717", { width, color: ACCENT_RED, bold: true, align: AlignmentType.CENTER, size: 22 });
}

function spacer() {
  return new Paragraph({ spacing: { after: 80 }, children: [] });
}

// ─── Document ────────────────────────────────────────────────────────────
const doc = new Document({
  styles: {
    default: { document: { run: { font: "Arial", size: 22 } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 36, bold: true, font: "Arial", color: ORIGIN_BLUE }, paragraph: { spacing: { before: 360, after: 240 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 28, bold: true, font: "Arial", color: DARK_BLUE }, paragraph: { spacing: { before: 240, after: 180 }, outlineLevel: 1 } },
      { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 24, bold: true, font: "Arial", color: MID_BLUE }, paragraph: { spacing: { before: 200, after: 120 }, outlineLevel: 2 } },
    ],
  },
  numbering: {
    config: [
      { reference: "bullets", levels: [{ level: 0, format: LevelFormat.BULLET, text: "\u2022", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
      { reference: "numbers", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
    ],
  },
  sections: [
    // ══════════════════════════ COVER PAGE ══════════════════════════
    {
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
        },
      },
      children: [
        new Paragraph({ spacing: { before: 3600 }, children: [] }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 200 },
          children: [new TextRun({ text: "COMPETITIVE LANDSCAPE", font: "Arial", size: 52, bold: true, color: ORIGIN_BLUE })]
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 120 },
          children: [new TextRun({ text: "ANALYSIS", font: "Arial", size: 52, bold: true, color: ORIGIN_BLUE })]
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 600 },
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: MID_BLUE, space: 1 } },
          children: [new TextRun({ text: "AI Code Governance & Developer Infrastructure", font: "Arial", size: 26, color: GRAY_TEXT })]
        }),
        new Paragraph({ spacing: { after: 200 }, children: [] }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 100 },
          children: [new TextRun({ text: "Prepared for Origin Platform", font: "Arial", size: 24, color: BLACK })]
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 100 },
          children: [new TextRun({ text: "April 2026", font: "Arial", size: 22, color: GRAY_TEXT })]
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: "CONFIDENTIAL", font: "Arial", size: 20, bold: true, color: ACCENT_RED })]
        }),
      ],
    },

    // ══════════════════════════ TOC + BODY ══════════════════════════
    {
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
        },
      },
      headers: {
        default: new Header({
          children: [new Paragraph({
            border: { bottom: { style: BorderStyle.SINGLE, size: 2, color: ORIGIN_BLUE, space: 4 } },
            children: [
              new TextRun({ text: "Origin Competitive Analysis", font: "Arial", size: 18, color: ORIGIN_BLUE, bold: true }),
              new TextRun({ text: "\tConfidential", font: "Arial", size: 16, color: GRAY_TEXT, italics: true }),
            ],
            tabStops: [{ type: "right", position: 9360 }],
          })]
        }),
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({ text: "Page ", font: "Arial", size: 18, color: GRAY_TEXT }),
              new TextRun({ children: [PageNumber.CURRENT], font: "Arial", size: 18, color: GRAY_TEXT }),
            ],
          })]
        }),
      },
      children: [
        // ─── Table of Contents ───
        new TableOfContents("Table of Contents", { hyperlink: true, headingStyleRange: "1-2" }),
        new Paragraph({ children: [new PageBreak()] }),

        // ════════════════════════════════════════════════════════════
        // EXECUTIVE SUMMARY
        // ════════════════════════════════════════════════════════════
        heading("Executive Summary"),
        body("This analysis evaluates five companies operating in the AI-native developer infrastructure space and their competitive positioning relative to Origin. The companies span PR workflow (Graphite), checkpoint/attribution (Entire), agent environments (Erco), automated code workflows (Gitar), and local-first git UX (GitButler)."),
        spacer(),
        body("Key finding: No single competitor covers Origin\u2019s full stack of governance + attribution + cost tracking + policy enforcement + checkpoints. Each addresses a narrow slice. Origin\u2019s competitive advantage lies in being the unified governance layer across all AI coding agents.", { bold: true }),
        spacer(),

        // Threat matrix table
        new Table({
          width: { size: TABLE_WIDTH, type: WidthType.DXA },
          columnWidths: [2400, 2400, 1560, 1560, 1440],
          rows: [
            new TableRow({ children: [
              headerCell("Company", 2400), headerCell("Focus Area", 2400),
              headerCell("Funding", 1560), headerCell("Threat", 1560), headerCell("Action", 1440),
            ]}),
            new TableRow({ children: [
              cell("Graphite", { width: 2400, bold: true }), cell("Stacked PRs + AI Review", { width: 2400 }),
              cell("$52M (acq. by Cursor)", { width: 1560 }), cell("Medium", { width: 1560, color: ACCENT_ORANGE, bold: true }), cell("Integrate", { width: 1440 }),
            ]}),
            new TableRow({ children: [
              cell("Entire", { width: 2400, bold: true }), cell("Checkpoints + Attribution", { width: 2400 }),
              cell("$60M seed", { width: 1560 }), cell("High", { width: 1560, color: ACCENT_RED, bold: true }), cell("Outpace", { width: 1440 }),
            ]}),
            new TableRow({ children: [
              cell("Erco", { width: 2400, bold: true }), cell("Agent Dev Environments", { width: 2400 }),
              cell("Unknown", { width: 1560 }), cell("None", { width: 1560, color: ACCENT_GREEN, bold: true }), cell("Monitor", { width: 1440 }),
            ]}),
            new TableRow({ children: [
              cell("Gitar", { width: 2400, bold: true }), cell("AI Auto-Fix + Workflows", { width: 2400 }),
              cell("Undisclosed", { width: 1560 }), cell("Low", { width: 1560, color: ACCENT_GREEN, bold: true }), cell("Partner", { width: 1440 }),
            ]}),
            new TableRow({ children: [
              cell("GitButler", { width: 2400, bold: true }), cell("Virtual Branches + Git UX", { width: 2400 }),
              cell("$17M Series A", { width: 1560 }), cell("Low", { width: 1560, color: ACCENT_GREEN, bold: true }), cell("Watch", { width: 1440 }),
            ]}),
          ],
        }),

        new Paragraph({ children: [new PageBreak()] }),

        // ════════════════════════════════════════════════════════════
        // FEATURE COMPARISON MATRIX
        // ════════════════════════════════════════════════════════════
        heading("Feature Comparison Matrix"),
        body("Comprehensive feature-by-feature comparison across all platforms."),
        spacer(),

        new Table({
          width: { size: TABLE_WIDTH, type: WidthType.DXA },
          columnWidths: COL_WIDTHS.feature,
          rows: [
            new TableRow({ children: [
              headerCell("Feature", 2800), headerCell("Origin", 1312), headerCell("Graphite", 1312),
              headerCell("Entire", 1312), headerCell("Gitar", 1312), headerCell("GitButler", 1312),
            ]}),
            // Session Tracking
            new TableRow({ children: [
              cell("Session Tracking", { width: 2800, bold: true, shading: GRAY_BG }),
              checkCell(true, 1312), checkCell(false, 1312), checkCell(true, 1312), checkCell(false, 1312), checkCell(false, 1312),
            ]}),
            new TableRow({ children: [
              cell("AI Attribution (who wrote what)", { width: 2800, bold: true }),
              checkCell(true, 1312), checkCell(false, 1312), checkCell("partial", 1312), checkCell(false, 1312), checkCell(false, 1312),
            ]}),
            new TableRow({ children: [
              cell("Cost Tracking", { width: 2800, bold: true, shading: GRAY_BG }),
              checkCell(true, 1312), checkCell(false, 1312), checkCell("partial", 1312), checkCell(false, 1312), checkCell(false, 1312),
            ]}),
            new TableRow({ children: [
              cell("Policy Enforcement", { width: 2800, bold: true }),
              checkCell(true, 1312), checkCell(false, 1312), checkCell(false, 1312), checkCell(true, 1312), checkCell(false, 1312),
            ]}),
            new TableRow({ children: [
              cell("Checkpoint/Rewind", { width: 2800, bold: true, shading: GRAY_BG }),
              checkCell(true, 1312), checkCell(false, 1312), checkCell(true, 1312), checkCell(false, 1312), checkCell(true, 1312),
            ]}),
            new TableRow({ children: [
              cell("AI Code Review", { width: 2800, bold: true }),
              checkCell(false, 1312), checkCell(true, 1312), checkCell(false, 1312), checkCell(true, 1312), checkCell(false, 1312),
            ]}),
            new TableRow({ children: [
              cell("PR Workflow / Stacked Diffs", { width: 2800, bold: true, shading: GRAY_BG }),
              checkCell(false, 1312), checkCell(true, 1312), checkCell(false, 1312), checkCell(false, 1312), checkCell("partial", 1312),
            ]}),
            new TableRow({ children: [
              cell("Multi-Agent Support", { width: 2800, bold: true }),
              checkCell(true, 1312), checkCell(false, 1312), checkCell(true, 1312), checkCell(false, 1312), checkCell(false, 1312),
            ]}),
            new TableRow({ children: [
              cell("Team Dashboard", { width: 2800, bold: true, shading: GRAY_BG }),
              checkCell(true, 1312), checkCell(true, 1312), checkCell(false, 1312), checkCell(true, 1312), checkCell(false, 1312),
            ]}),
            new TableRow({ children: [
              cell("Git-Native (no external DB)", { width: 2800, bold: true }),
              checkCell(true, 1312), checkCell(false, 1312), checkCell(true, 1312), checkCell(false, 1312), checkCell(true, 1312),
            ]}),
            new TableRow({ children: [
              cell("Enterprise / On-Prem", { width: 2800, bold: true, shading: GRAY_BG }),
              checkCell("partial", 1312), checkCell(true, 1312), checkCell(false, 1312), checkCell(true, 1312), checkCell(false, 1312),
            ]}),
          ],
        }),

        new Paragraph({ children: [new PageBreak()] }),

        // ════════════════════════════════════════════════════════════
        // INDIVIDUAL COMPANY ANALYSES
        // ════════════════════════════════════════════════════════════
        heading("Individual Company Analyses"),

        // ─── GRAPHITE ───
        heading("Graphite", HeadingLevel.HEADING_2),
        new Table({
          width: { size: TABLE_WIDTH, type: WidthType.DXA },
          columnWidths: COL_WIDTHS.twoCol,
          rows: [
            new TableRow({ children: [
              cell("Website", { width: 4680, bold: true, shading: LIGHT_BLUE }), cell("graphite.com", { width: 4680 }),
            ]}),
            new TableRow({ children: [
              cell("Funding", { width: 4680, bold: true, shading: LIGHT_BLUE }), cell("$52M Series B (acquired by Cursor Dec 2025)", { width: 4680 }),
            ]}),
            new TableRow({ children: [
              cell("Investors", { width: 4680, bold: true, shading: LIGHT_BLUE }), cell("Anthropic, Figma, Shopify", { width: 4680 }),
            ]}),
            new TableRow({ children: [
              cell("Pricing", { width: 4680, bold: true, shading: LIGHT_BLUE }), cell("Free \u2192 $20/user/mo \u2192 $40/user/mo \u2192 Enterprise", { width: 4680 }),
            ]}),
            new TableRow({ children: [
              cell("Threat Level", { width: 4680, bold: true, shading: LIGHT_BLUE }), cell("MEDIUM", { width: 4680, color: ACCENT_ORANGE, bold: true }),
            ]}),
          ],
        }),
        spacer(),
        heading("What They Do", HeadingLevel.HEADING_3),
        bulletItem(" Stacked PRs natively on GitHub (historically only Meta/Google had this)", "Stacked Diffs:"),
        bulletItem(" AI code reviewer with <3% unhelpful comment rate; devs change code 55% of the time", "AI Review:"),
        bulletItem(" Automated merge queues with CI gate enforcement", "Merge Queue:"),
        bulletItem(" Developer productivity metrics, cycle time, PR throughput", "Analytics:"),
        spacer(),
        heading("Relevance to Origin", HeadingLevel.HEADING_3),
        bulletItem(" Their analytics engine tracks developer productivity. Origin should surface AI-contribution ratios, cost per dev, sessions per dev in the same style", "Developer Analytics:"),
        bulletItem(" They inject AI review at PR time. Origin could inject attribution data into PR comments (e.g. \"87% AI-generated, 3 sessions, $0.42 cost\")", "PR-Time Governance:"),
        bulletItem(" Merge queues are a natural enforcement point for policies like \"no PR with >X% AI code without human review\"", "Policy Checkpoint:"),
        bulletItem(" Acquired by Cursor \u2014 deep IDE integration. Origin should integrate similarly with multiple agents", "Cursor Integration:"),

        new Paragraph({ children: [new PageBreak()] }),

        // ─── ENTIRE ───
        heading("Entire", HeadingLevel.HEADING_2),
        new Table({
          width: { size: TABLE_WIDTH, type: WidthType.DXA },
          columnWidths: COL_WIDTHS.twoCol,
          rows: [
            new TableRow({ children: [
              cell("Website", { width: 4680, bold: true, shading: LIGHT_BLUE }), cell("entire.io", { width: 4680 }),
            ]}),
            new TableRow({ children: [
              cell("Funding", { width: 4680, bold: true, shading: LIGHT_BLUE }), cell("$60M seed at $300M valuation (Felicis-led)", { width: 4680 }),
            ]}),
            new TableRow({ children: [
              cell("Founder", { width: 4680, bold: true, shading: LIGHT_BLUE }), cell("Thomas Dohmke (ex-GitHub CEO)", { width: 4680 }),
            ]}),
            new TableRow({ children: [
              cell("Pricing", { width: 4680, bold: true, shading: LIGHT_BLUE }), cell("Free / open-source CLI. No paid product yet", { width: 4680 }),
            ]}),
            new TableRow({ children: [
              cell("Threat Level", { width: 4680, bold: true, shading: LIGHT_BLUE }), cell("HIGH", { width: 4680, color: ACCENT_RED, bold: true }),
            ]}),
          ],
        }),
        spacer(),
        heading("What They Do", HeadingLevel.HEADING_3),
        bulletItem(" Only shipped product. Captures AI agent sessions on every git push via shadow branches", "Checkpoints CLI:"),
        bulletItem(" Stores sessions on orphan branch (entire/checkpoints/v1) with metadata, transcripts, prompts", "Local Storage:"),
        bulletItem(" Supports Claude Code, Gemini CLI, Cursor, OpenCode, Copilot CLI", "Agent Support:"),
        bulletItem(" Routes session data to separate repos for compliance", "--checkpoint-remote:"),
        bulletItem(" Git-compatible database unifying code, intent, and constraints (not shipped)", "Vision:"),
        spacer(),
        heading("Origin\u2019s Advantage", HeadingLevel.HEADING_3),
        body("Origin has already replicated Entire\u2019s checkpoint system with identical architecture (chained shadow branch commits, permanent orphan branch, bidirectional linking, tree deduplication). Additionally, Origin ships governance, policy enforcement, cost tracking, team dashboard, and multi-agent support \u2014 none of which Entire has.", { bold: true }),
        spacer(),
        bulletItem(" Entire captures raw session data but has zero governance layer on top", "No Governance:"),
        bulletItem(" No pricing, no hosted service, no team management", "No Revenue:"),
        bulletItem(" $60M seed with ex-GitHub CEO means rapid development expected", "Risk:"),
        bulletItem(" Add --checkpoint-remote flag, auto-summarization, context graph concept", "Steal:"),

        new Paragraph({ children: [new PageBreak()] }),

        // ─── ERCO ───
        heading("Erco", HeadingLevel.HEADING_2),
        new Table({
          width: { size: TABLE_WIDTH, type: WidthType.DXA },
          columnWidths: COL_WIDTHS.twoCol,
          rows: [
            new TableRow({ children: [
              cell("Website", { width: 4680, bold: true, shading: LIGHT_BLUE }), cell("erco.dev", { width: 4680 }),
            ]}),
            new TableRow({ children: [
              cell("Status", { width: 4680, bold: true, shading: LIGHT_BLUE }), cell("Does not exist as described", { width: 4680, color: ACCENT_RED }),
            ]}),
            new TableRow({ children: [
              cell("Threat Level", { width: 4680, bold: true, shading: LIGHT_BLUE }), cell("NONE", { width: 4680, color: ACCENT_GREEN, bold: true }),
            ]}),
          ],
        }),
        spacer(),
        body("The domain erco.dev belongs to an individual IT consultant. There is no product, no platform, and no evidence of an \"Agent-Driven Dev Environments\" company. The source that identified Erco as a threat was likely misinformed or referenced a stealth/pre-launch effort with zero public footprint."),
        spacer(),
        heading("Real Players in Agent Dev Environments", HeadingLevel.HEADING_3),
        bulletItem(" Factory.ai \u2014 agent-native software development for enterprises"),
        bulletItem(" Kiro (kiro.dev) \u2014 AWS-backed agentic IDE with spec-driven development"),
        bulletItem(" Warp (warp.dev) \u2014 agentic terminal with 700K+ developers"),
        bulletItem(" JetBrains Air \u2014 multi-agent development environment"),

        new Paragraph({ children: [new PageBreak()] }),

        // ─── GITAR ───
        heading("Gitar (UseGital)", HeadingLevel.HEADING_2),
        new Table({
          width: { size: TABLE_WIDTH, type: WidthType.DXA },
          columnWidths: COL_WIDTHS.twoCol,
          rows: [
            new TableRow({ children: [
              cell("Website", { width: 4680, bold: true, shading: LIGHT_BLUE }), cell("gitar.ai", { width: 4680 }),
            ]}),
            new TableRow({ children: [
              cell("Founded by", { width: 4680, bold: true, shading: LIGHT_BLUE }), cell("Gautam Korlam (ex-Uber Dev Stack team)", { width: 4680 }),
            ]}),
            new TableRow({ children: [
              cell("Pricing", { width: 4680, bold: true, shading: LIGHT_BLUE }), cell("Free \u2192 ~$20/user/mo \u2192 Enterprise (on-prem)", { width: 4680 }),
            ]}),
            new TableRow({ children: [
              cell("Compliance", { width: 4680, bold: true, shading: LIGHT_BLUE }), cell("SOC 2 Type II, ISO 27001, GDPR", { width: 4680 }),
            ]}),
            new TableRow({ children: [
              cell("Threat Level", { width: 4680, bold: true, shading: LIGHT_BLUE }), cell("LOW", { width: 4680, color: ACCENT_GREEN, bold: true }),
            ]}),
          ],
        }),
        spacer(),
        heading("What They Do", HeadingLevel.HEADING_3),
        bulletItem(" Goes beyond commenting to actually fix code and commit fixes to PRs", "AI Auto-Fix:"),
        bulletItem(" Analyzes CI failures (lint, test, build), identifies root causes, generates validated fixes", "CI Integration:"),
        bulletItem(" Teams define policies in plain English (e.g. \"enforce lint rules\", \"add PR checklists\")", "Natural Language Policies:"),
        bulletItem(" Handles Pinterest-scale codebases (50M+ lines, thousands of daily PRs)", "Scale:"),
        bulletItem(" BYOLLM, MCP support, SaaS or full on-prem deployment", "Enterprise:"),
        spacer(),
        heading("Relevance to Origin", HeadingLevel.HEADING_3),
        bulletItem(" Instead of YAML config, let users write \"don\u2019t allow AI to modify auth files\" in plain English", "Natural Language Policies:"),
        bulletItem(" Plug into CircleCI/Jenkins/BuildKite to block policy-violating AI code at CI time", "CI/CD Integration:"),
        bulletItem(" More integration partner than competitor \u2014 they lack session tracking, attribution, cost tracking", "Partnership:"),

        new Paragraph({ children: [new PageBreak()] }),

        // ─── GITBUTLER ───
        heading("GitButler", HeadingLevel.HEADING_2),
        new Table({
          width: { size: TABLE_WIDTH, type: WidthType.DXA },
          columnWidths: COL_WIDTHS.twoCol,
          rows: [
            new TableRow({ children: [
              cell("Website", { width: 4680, bold: true, shading: LIGHT_BLUE }), cell("gitbutler.com", { width: 4680 }),
            ]}),
            new TableRow({ children: [
              cell("Funding", { width: 4680, bold: true, shading: LIGHT_BLUE }), cell("$17M Series A (a16z, Fly Ventures)", { width: 4680 }),
            ]}),
            new TableRow({ children: [
              cell("Tech Stack", { width: 4680, bold: true, shading: LIGHT_BLUE }), cell("Rust backend, Tauri framework, Svelte/TypeScript", { width: 4680 }),
            ]}),
            new TableRow({ children: [
              cell("License", { width: 4680, bold: true, shading: LIGHT_BLUE }), cell("Fair Source (becomes MIT after 2 years)", { width: 4680 }),
            ]}),
            new TableRow({ children: [
              cell("Threat Level", { width: 4680, bold: true, shading: LIGHT_BLUE }), cell("LOW", { width: 4680, color: ACCENT_GREEN, bold: true }),
            ]}),
          ],
        }),
        spacer(),
        heading("What They Do", HeadingLevel.HEADING_3),
        bulletItem(" Work on multiple branches simultaneously in one working directory without stashing", "Virtual Branches:"),
        bulletItem(" Tracks which diffs belong to which branch BEFORE commit", "Pre-Commit Tracking:"),
        bulletItem(" Drag-and-drop code hunks between branches", "Hunk-Level Control:"),
        bulletItem(" Full history of every action, can undo any operation", "Unlimited Undo:"),
        bulletItem(" AI-generated commit messages, forge integrations (GitHub/GitLab)", "AI Features:"),
        spacer(),
        heading("Relevance to Origin", HeadingLevel.HEADING_3),
        bulletItem(" They track changes pre-commit similar to Origin\u2019s session tracking. Could pivot toward attribution", "Change Tracking:"),
        bulletItem(" They know which hunks go where. Origin should track AI vs human at hunk level, not just file level", "Hunk-Level Attribution:"),
        bulletItem(" Their undo UX validates Origin\u2019s checkpoint/rewind approach", "Undo as Pattern:"),
        bulletItem(" Solves workflow UX, not governance. Low-medium threat only if they add policy features", "Threat Assessment:"),

        new Paragraph({ children: [new PageBreak()] }),

        // ════════════════════════════════════════════════════════════
        // STRATEGIC PRIORITIES
        // ════════════════════════════════════════════════════════════
        heading("Strategic Priorities"),
        body("Features to build based on competitive intelligence, ranked by impact and effort."),
        spacer(),

        new Table({
          width: { size: TABLE_WIDTH, type: WidthType.DXA },
          columnWidths: COL_WIDTHS.priority,
          rows: [
            new TableRow({ children: [
              headerCell("Feature", 3200), headerCell("Source", 1200), headerCell("Effort", 1200),
              headerCell("Impact", 1880), headerCell("Priority", 1880),
            ]}),
            new TableRow({ children: [
              cell("PR comment injection (AI % + cost)", { width: 3200 }), cell("Graphite", { width: 1200 }),
              cell("Medium", { width: 1200 }), cell("HIGH", { width: 1880, color: ACCENT_RED, bold: true }),
              cell("P0", { width: 1880, color: ACCENT_RED, bold: true }),
            ]}),
            new TableRow({ children: [
              cell("Natural language policies", { width: 3200 }), cell("Gitar", { width: 1200 }),
              cell("Medium", { width: 1200 }), cell("HIGH", { width: 1880, color: ACCENT_RED, bold: true }),
              cell("P0", { width: 1880, color: ACCENT_RED, bold: true }),
            ]}),
            new TableRow({ children: [
              cell("Developer analytics dashboard", { width: 3200 }), cell("Graphite", { width: 1200 }),
              cell("Medium", { width: 1200 }), cell("HIGH", { width: 1880, color: ACCENT_RED, bold: true }),
              cell("P1", { width: 1880, color: ACCENT_ORANGE, bold: true }),
            ]}),
            new TableRow({ children: [
              cell("CI/CD pipeline integration", { width: 3200 }), cell("Gitar", { width: 1200 }),
              cell("High", { width: 1200 }), cell("HIGH", { width: 1880, color: ACCENT_RED, bold: true }),
              cell("P1", { width: 1880, color: ACCENT_ORANGE, bold: true }),
            ]}),
            new TableRow({ children: [
              cell("--checkpoint-remote flag", { width: 3200 }), cell("Entire", { width: 1200 }),
              cell("Low", { width: 1200 }), cell("MEDIUM", { width: 1880, color: ACCENT_ORANGE, bold: true }),
              cell("P2", { width: 1880, color: ACCENT_GREEN, bold: true }),
            ]}),
            new TableRow({ children: [
              cell("Auto-session summarization", { width: 3200 }), cell("Entire", { width: 1200 }),
              cell("Low", { width: 1200 }), cell("MEDIUM", { width: 1880, color: ACCENT_ORANGE, bold: true }),
              cell("P2", { width: 1880, color: ACCENT_GREEN, bold: true }),
            ]}),
            new TableRow({ children: [
              cell("Hunk-level AI attribution", { width: 3200 }), cell("GitButler", { width: 1200 }),
              cell("High", { width: 1200 }), cell("MEDIUM", { width: 1880, color: ACCENT_ORANGE, bold: true }),
              cell("P3", { width: 1880, color: MID_BLUE, bold: true }),
            ]}),
          ],
        }),

        spacer(),
        spacer(),

        // ════════════════════════════════════════════════════════════
        // CONCLUSION
        // ════════════════════════════════════════════════════════════
        heading("Conclusion"),
        body("Origin occupies a unique position in the AI developer tools landscape as the only platform combining governance, attribution, cost tracking, policy enforcement, and checkpoints in a single product. The closest competitor (Entire) has $60M in funding but only ships a checkpoint CLI with no governance layer \u2014 Origin already matches their checkpoint architecture and far exceeds their feature set."),
        spacer(),
        body("The primary gaps to close are PR-time integration (inspired by Graphite) and natural language policy definitions (inspired by Gitar). These two features would make Origin the definitive governance layer for AI-generated code, bridging the gap between where code is written (IDEs/agents) and where it\u2019s reviewed (pull requests/CI pipelines)."),
        spacer(),
        body("Recommended immediate actions:", { bold: true }),
        bulletItem(" Build PR comment injection with AI attribution data and cost metrics"),
        bulletItem(" Implement natural language policy definitions"),
        bulletItem(" Add --checkpoint-remote flag for enterprise compliance"),
        bulletItem(" Develop developer analytics dashboard (AI usage per dev, cost trends)"),
        bulletItem(" Explore CI/CD integration for policy enforcement at build time"),
      ],
    },
  ],
});

// ─── Write ───────────────────────────────────────────────────────────────
Packer.toBuffer(doc).then(buffer => {
  const outPath = "/Users/artemdolobanko/origin/origin-v2/Origin_Competitive_Analysis.docx";
  fs.writeFileSync(outPath, buffer);
  console.log("Written to:", outPath);
});
