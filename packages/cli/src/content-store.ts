import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

// ─── Content-Addressable Transcript Storage ──────────────────────────────
//
// Builds on the blob storage in local-db.ts but adds transcript-specific
// features: chunking large transcripts, manifest files for reassembly,
// and content-addressable retrieval by SHA-256 hash.

const STORE_DIR = path.join(os.homedir(), '.origin', 'transcripts');
const MANIFEST_DIR = path.join(os.homedir(), '.origin', 'manifests');

// Default chunk size: 500KB
const DEFAULT_CHUNK_SIZE = 500 * 1024;

// ─── Types ────────────────────────────────────────────────────────────────

export interface TranscriptManifest {
  version: 1;
  hash: string;           // SHA-256 of full content
  totalSize: number;
  chunkCount: number;
  chunks: ChunkInfo[];
  createdAt: string;
}

export interface ChunkInfo {
  index: number;
  hash: string;
  size: number;
  offset: number;
}

// ─── Initialization ──────────────────────────────────────────────────────

function ensureStoreDir(): void {
  fs.mkdirSync(STORE_DIR, { recursive: true });
}

function ensureManifestDir(): void {
  fs.mkdirSync(MANIFEST_DIR, { recursive: true });
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function blobPath(hash: string): string {
  return path.join(STORE_DIR, hash.slice(0, 2), hash.slice(2));
}

function manifestPath(hash: string): string {
  return path.join(MANIFEST_DIR, `${hash}.json`);
}

// ─── Chunk Operations ────────────────────────────────────────────────────

/**
 * Split content into chunks at JSONL line boundaries.
 * Ensures chunks don't split in the middle of a JSON line.
 */
function chunkContent(content: string, maxSize: number = DEFAULT_CHUNK_SIZE): string[] {
  if (content.length <= maxSize) {
    return [content];
  }

  const chunks: string[] = [];
  const lines = content.split('\n');
  let currentChunk = '';

  for (const line of lines) {
    const newChunk = currentChunk ? currentChunk + '\n' + line : line;
    if (newChunk.length > maxSize && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = line;
    } else {
      currentChunk = newChunk;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks;
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Store a transcript. Returns the SHA-256 hash of the full content.
 *
 * If the transcript is small enough, stores as a single blob.
 * If large, chunks it and creates a manifest for reassembly.
 */
export function storeTranscript(content: string): string {
  ensureStoreDir();
  const fullHash = hashContent(content);

  // Check if already stored
  if (fs.existsSync(blobPath(fullHash)) || fs.existsSync(manifestPath(fullHash))) {
    return fullHash;
  }

  const chunks = chunkContent(content);

  if (chunks.length === 1) {
    // Single chunk — store directly
    const dir = path.join(STORE_DIR, fullHash.slice(0, 2));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(blobPath(fullHash), content);
  } else {
    // Multiple chunks — store each chunk and create manifest
    const chunkInfos: ChunkInfo[] = [];
    let offset = 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunkHash = hashContent(chunks[i]);
      const dir = path.join(STORE_DIR, chunkHash.slice(0, 2));
      fs.mkdirSync(dir, { recursive: true });

      if (!fs.existsSync(blobPath(chunkHash))) {
        fs.writeFileSync(blobPath(chunkHash), chunks[i]);
      }

      chunkInfos.push({
        index: i,
        hash: chunkHash,
        size: chunks[i].length,
        offset,
      });
      offset += chunks[i].length;
    }

    // Write manifest
    const manifest: TranscriptManifest = {
      version: 1,
      hash: fullHash,
      totalSize: content.length,
      chunkCount: chunks.length,
      chunks: chunkInfos,
      createdAt: new Date().toISOString(),
    };

    ensureManifestDir();
    fs.writeFileSync(manifestPath(fullHash), JSON.stringify(manifest, null, 2));
  }

  return fullHash;
}

/**
 * Retrieve a transcript by its hash.
 * Handles both single-blob and chunked storage transparently.
 */
export function getTranscript(hash: string): string | null {
  // Try single blob first
  const singlePath = blobPath(hash);
  try {
    if (fs.existsSync(singlePath)) {
      return fs.readFileSync(singlePath, 'utf-8');
    }
  } catch { /* fall through */ }

  // Try manifest
  const mPath = manifestPath(hash);
  try {
    if (!fs.existsSync(mPath)) return null;

    const manifest: TranscriptManifest = JSON.parse(fs.readFileSync(mPath, 'utf-8'));
    const parts: string[] = [];

    for (const chunk of manifest.chunks.sort((a, b) => a.index - b.index)) {
      const chunkPath = blobPath(chunk.hash);
      if (!fs.existsSync(chunkPath)) {
        return null; // Missing chunk — data integrity issue
      }
      parts.push(fs.readFileSync(chunkPath, 'utf-8'));
    }

    return parts.join('');
  } catch {
    return null;
  }
}

/**
 * Check if a transcript exists in the store.
 */
export function hasTranscript(hash: string): boolean {
  return fs.existsSync(blobPath(hash)) || fs.existsSync(manifestPath(hash));
}

/**
 * Get the manifest for a chunked transcript (null if single-blob or not found).
 */
export function getManifest(hash: string): TranscriptManifest | null {
  try {
    const mPath = manifestPath(hash);
    if (!fs.existsSync(mPath)) return null;
    return JSON.parse(fs.readFileSync(mPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Get storage stats.
 */
export function getStoreStats(): { transcripts: number; totalSize: number; chunks: number } {
  let transcripts = 0;
  let totalSize = 0;
  let chunks = 0;

  try {
    // Count manifests
    ensureManifestDir();
    const manifests = fs.readdirSync(MANIFEST_DIR).filter(f => f.endsWith('.json'));
    transcripts += manifests.length;

    // Count blobs
    ensureStoreDir();
    const dirs = fs.readdirSync(STORE_DIR, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const files = fs.readdirSync(path.join(STORE_DIR, dir.name));
      chunks += files.length;
      for (const file of files) {
        const stat = fs.statSync(path.join(STORE_DIR, dir.name, file));
        totalSize += stat.size;
      }
    }

    // Single-blob transcripts (no manifest) are also transcripts
    transcripts += chunks - manifests.reduce((sum, m) => {
      try {
        const manifest: TranscriptManifest = JSON.parse(
          fs.readFileSync(path.join(MANIFEST_DIR, m), 'utf-8'),
        );
        return sum + manifest.chunkCount;
      } catch {
        return sum;
      }
    }, 0);
  } catch { /* ignore */ }

  return { transcripts: Math.max(0, transcripts), totalSize, chunks };
}
