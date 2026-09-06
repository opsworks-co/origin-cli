/**
 * Uploading the images a prompt carried.
 *
 * Shared by the Stop hook and the transcript watcher. It lived inline in the
 * Stop hook, which meant every agent that fires no hooks — the whole reason the
 * watcher exists — captured no screenshots at all, on any platform where the
 * agent is a GUI app.
 */

import { extractPromptImages } from './transcript.js';

/** Server cap. Checked locally too so an over-cap image costs no roundtrip. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Identifies one image within a session: which prompt, and which `[image]`
 *  placeholder inside it. Stable across polls, so the watcher can latch what it
 *  has already sent instead of re-uploading every 8 seconds. */
export function imageKey(promptIndex: number, imageIndex: number): string {
  return `${promptIndex}:${imageIndex}`;
}

export interface UploadPromptImagesResult {
  /** Keys uploaded on THIS pass — the caller merges them into its own state. */
  uploaded: string[];
  /** The user has image capture turned off. Nothing more will land this pass. */
  optedOut: boolean;
  /**
   * imageKey → the server's one-line caption of that image.
   *
   * The reason this round-trips at all: git notes are written from the CLI's
   * own copy of the prompt text, so a caption that only ever existed in the
   * database would leave the repo's memory holding a bare `[image]` — the
   * exact hole the caption exists to fill.
   */
  descriptions: Record<string, string>;
}

/**
 * Fold captions into one prompt's text for the RECORD — git notes, memory.
 *
 * Deliberately separate from the server's splice, which rewrites its own copy
 * to `[image:<id>]`. Two readers, two renderings of the same slot: the
 * dashboard needs an id it can fetch bytes with, a git note needs words. The
 * CLI never sends this rendering back, so the two cannot fight over the row.
 *
 * The caption stays inside the bracket marker on purpose. It was written by a
 * model looking at a picture, not by the user, and a record whose value is
 * "what the human actually asked for" must not blur those together.
 */
export function applyImageDescriptions(
  promptText: string,
  descriptionsByImageIndex: Record<number, string>,
): string {
  if (!promptText) return promptText;
  let slot = -1;
  return promptText.replace(/\[image(?::[A-Za-z0-9_-]+)?\]/g, (match) => {
    slot++;
    const description = descriptionsByImageIndex[slot];
    if (!description) return match;
    // `]` would end the marker early and `"` is the quoting we add.
    const safe = description.replace(/[\]"]/g, '').trim();
    return safe ? `[image: "${safe}"]` : match;
  });
}

export async function uploadPromptImages(opts: {
  sessionId: string;
  transcriptPath: string;
  upload: (
    sessionId: string,
    payload: { promptIndex: number; imageIndex: number; mediaType: string; base64: string },
  ) => Promise<unknown>;
  /** Keys from previous passes; skipped without a roundtrip. */
  alreadyUploaded?: readonly string[];
  debug?: (event: string, data: Record<string, unknown>) => void;
}): Promise<UploadPromptImagesResult> {
  const { sessionId, transcriptPath, upload } = opts;
  const debug = opts.debug ?? (() => {});
  const seen = new Set(opts.alreadyUploaded ?? []);
  const uploaded: string[] = [];
  const descriptions: Record<string, string> = {};

  let images: ReturnType<typeof extractPromptImages>;
  try {
    images = extractPromptImages(transcriptPath);
  } catch (err: any) {
    debug('image extraction failed (non-fatal)', { message: err?.message ?? String(err) });
    return { uploaded, optedOut: false, descriptions };
  }

  const pending = images.filter((img) => !seen.has(imageKey(img.promptIndex, img.imageIndex)));
  if (pending.length === 0) return { uploaded, optedOut: false, descriptions };
  debug('image upload begin', { count: pending.length, skipped: images.length - pending.length });

  for (const img of pending) {
    const key = imageKey(img.promptIndex, img.imageIndex);
    if (img.sizeBytes > MAX_IMAGE_BYTES) {
      // Latched: the size will not change on the next poll, and the prompt keeps
      // its bare `[image]` placeholder — the honest record that an image was
      // part of the prompt and its bytes were not stored.
      debug('image too large, skip', { promptIndex: img.promptIndex, sizeBytes: img.sizeBytes });
      uploaded.push(key);
      continue;
    }
    try {
      const res: any = await upload(sessionId, {
        promptIndex: img.promptIndex,
        imageIndex: img.imageIndex,
        mediaType: img.mediaType,
        base64: img.base64,
      });
      uploaded.push(key);
      if (res && typeof res.description === 'string' && res.description.trim()) {
        descriptions[key] = res.description.trim();
      }
    } catch (err: any) {
      const status = err?.status || err?.code;
      if (status === 403 || /disabled/i.test(err?.message || '')) {
        // Not latched — the user can flip the toggle in Settings and the next
        // pass should pick these up without restarting the agent.
        debug('image capture disabled for user — stopping', {});
        return { uploaded, optedOut: true, descriptions };
      }
      // A 404 means the prompt's row hasn't landed yet (the watcher can poll
      // mid-turn). Also not latched: retried next pass.
      debug('image upload failed (non-fatal)', {
        promptIndex: img.promptIndex,
        message: err?.message || String(err),
      });
    }
  }

  return { uploaded, optedOut: false, descriptions };
}
