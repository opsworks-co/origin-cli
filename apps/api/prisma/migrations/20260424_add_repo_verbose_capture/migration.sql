-- Opt-in flag: when on, the CLI captures full tool inputs and tool_result
-- bodies in session transcripts (not just one-line summaries). Off by default
-- to keep transcript size bounded for repos that don't want verbose capture.
ALTER TABLE "Repo" ADD COLUMN "verboseCapture" BOOLEAN NOT NULL DEFAULT false;
