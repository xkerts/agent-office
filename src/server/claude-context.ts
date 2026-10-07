// How big a Claude worker's context window is. Claude Code's transcript says how many tokens each
// call sent, but not the window they went into: 200k, or 1M for a `[1m]` model (`opus[1m]`). That
// suffix is only in what the worker was asked to run on: its --model, else ANTHROPIC_MODEL, else the
// `model` in Claude Code's settings.json, the same order Claude Code itself goes by.

import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CLAUDE_WINDOW = 200_000;
export const CLAUDE_WINDOW_1M = 1_000_000;

let settings: { file: string; stamp: string; model?: string } | undefined;

/** The `model` in Claude Code's own settings.json, read again only when the file changes. */
function settingsModel(): string | undefined {
  const file = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
  let stamp: string;
  try {
    const st = statSync(file);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    return undefined;
  }
  if (settings?.file !== file || settings.stamp !== stamp) {
    let model: string | undefined;
    try {
      const v = JSON.parse(readFileSync(file, 'utf8'))?.model;
      if (typeof v === 'string') model = v;
    } catch {
      // half-written or not JSON: no model from it
    }
    settings = { file, stamp, model };
  }
  return settings.model;
}

/**
 * The window a Claude worker's context fills: 1M when what it runs on asks for one, or when it
 * has held more than 200k (which only fits in 1M); 200k otherwise. `requested` is the model the
 * worker was hired with, if any.
 */
export function claudeContextSize(used: number, requested?: string): number {
  const model = requested || process.env.ANTHROPIC_MODEL || settingsModel() || '';
  return /\[1m\]/i.test(model) || used > CLAUDE_WINDOW ? CLAUDE_WINDOW_1M : CLAUDE_WINDOW;
}
