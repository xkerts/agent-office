import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { newTracker, restoreTracker, scanTracker, trackerUsage } from '../src/server/usage.js';

const assistant = (id: string, model: string, more: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'assistant', timestamp: new Date(Date.UTC(2026, 9, 1, 12, 0, Number(id))).toISOString(), ...more, message: { id: `msg_${id}`, model, usage: { input_tokens: 10, output_tokens: 5 } } });

test('a Claude session\'s usage names the model its own latest message ran on', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ao-usage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const transcript = path.join(dir, 'session.jsonl');
  const tracker = newTracker();
  tracker.transcript = transcript;
  assert.equal(trackerUsage(tracker).model, undefined);

  writeFileSync(transcript, `${assistant('1', 'claude-opus-5-5')}\n`);
  assert.equal(scanTracker(tracker), true);
  assert.equal(trackerUsage(tracker).model, 'claude-opus-5-5');
  assert.equal(trackerUsage(tracker).calls, 1);

  // A subagent on another model, and Claude Code's own placeholder messages, don't change what the session runs on.
  const subagents = path.join(dir, 'session', 'subagents');
  mkdirSync(subagents, { recursive: true });
  writeFileSync(path.join(subagents, 'agent-1.jsonl'), `${assistant('2', 'claude-haiku-4-5-20251001')}\n`);
  writeFileSync(transcript, `${assistant('1', 'claude-opus-5-5')}\n${assistant('3', '<synthetic>')}\n${assistant('4', 'claude-haiku-4-5-20251001', { isSidechain: true })}\n`);
  assert.equal(scanTracker(tracker), true);
  assert.equal(trackerUsage(tracker).model, 'claude-opus-5-5');
  assert.equal(trackerUsage(tracker).calls, 4);

  // Switched with /model: the card follows.
  writeFileSync(transcript, `${assistant('1', 'claude-opus-5-5')}\n${assistant('3', '<synthetic>')}\n${assistant('4', 'claude-haiku-4-5-20251001', { isSidechain: true })}\n${assistant('5', 'claude-sonnet-5-5')}\n`);
  scanTracker(tracker);
  assert.equal(trackerUsage(tracker).model, 'claude-sonnet-5-5');

  // And it's kept across a restart, with the rest of the tracker.
  const restored = restoreTracker(JSON.parse(JSON.stringify(tracker)));
  assert.equal(trackerUsage(restored).model, 'claude-sonnet-5-5');
  assert.equal(restoreTracker({ ...tracker, model: 'not a model\u0007' }).model, undefined);
});

test('a Claude session\'s context: what its own latest call sent, out of 200k or 1M', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ao-context-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const prevModel = process.env.ANTHROPIC_MODEL;
  const prevConfig = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.ANTHROPIC_MODEL;
  // Claude Code's own settings, with no model in them yet.
  process.env.CLAUDE_CONFIG_DIR = dir;
  t.after(() => {
    if (prevModel === undefined) delete process.env.ANTHROPIC_MODEL;
    else process.env.ANTHROPIC_MODEL = prevModel;
    if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfig;
  });
  writeFileSync(path.join(dir, 'settings.json'), '{}');
  const call = (id: string, usage: Record<string, number>, more: Record<string, unknown> = {}) =>
    JSON.stringify({ type: 'assistant', timestamp: new Date(Date.UTC(2026, 9, 1, 12, 0, Number(id))).toISOString(), ...more, message: { id: `msg_${id}`, model: 'claude-opus-5-5', usage } });
  const transcript = path.join(dir, 'session.jsonl');
  const tracker = newTracker();
  tracker.transcript = transcript;
  const lines: string[] = [];
  const log = (...more: string[]) => {
    lines.push(...more);
    writeFileSync(transcript, lines.join('\n') + '\n');
    scanTracker(tracker);
  };

  // No call yet: nothing to say.
  writeFileSync(transcript, '');
  scanTracker(tracker);
  assert.equal(trackerUsage(tracker).contextUsed, undefined);
  assert.equal(trackerUsage(tracker).contextSize, undefined);

  // Input, cache write and cache read of the latest call; its output isn't in the context until the next one sends it.
  log(call('1', { input_tokens: 3, cache_creation_input_tokens: 20_000, cache_read_input_tokens: 0, output_tokens: 400 }));
  log(call('2', { input_tokens: 2, cache_creation_input_tokens: 1_000, cache_read_input_tokens: 143_000, output_tokens: 300 }));
  assert.equal(trackerUsage(tracker).contextUsed, 144_002);
  assert.equal(trackerUsage(tracker).contextSize, 200_000);

  // A subagent's calls fill its own context, not the session's.
  log(call('3', { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 190_000, output_tokens: 10 }, { isSidechain: true }));
  const subagents = path.join(dir, 'session', 'subagents');
  mkdirSync(subagents, { recursive: true });
  writeFileSync(path.join(subagents, 'agent-1.jsonl'), call('4', { input_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 5_000, output_tokens: 1 }) + '\n');
  scanTracker(tracker);
  assert.equal(trackerUsage(tracker).contextUsed, 144_002);

  // A 1M model, by what the worker was hired on, ANTHROPIC_MODEL, or Claude Code's settings.
  assert.equal(trackerUsage(tracker, 'opus[1m]').contextSize, 1_000_000);
  assert.equal(trackerUsage(tracker, 'opus').contextSize, 200_000);
  process.env.ANTHROPIC_MODEL = 'claude-opus-5-5[1m]';
  assert.equal(trackerUsage(tracker).contextSize, 1_000_000);
  delete process.env.ANTHROPIC_MODEL;
  writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: 'opus[1m]' }));
  assert.equal(trackerUsage(tracker).contextSize, 1_000_000);
  // --model wins over the settings, as in Claude Code.
  assert.equal(trackerUsage(tracker, 'sonnet').contextSize, 200_000);
  writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: 'opus' }) + ' ');
  assert.equal(trackerUsage(tracker).contextSize, 200_000);

  // Past 200k it can only be a 1M window, and it stays one once compacted.
  log(call('5', { input_tokens: 1, cache_creation_input_tokens: 5_000, cache_read_input_tokens: 240_000, output_tokens: 50 }));
  assert.deepEqual([trackerUsage(tracker).contextUsed, trackerUsage(tracker).contextSize], [245_001, 1_000_000]);
  log(call('6', { input_tokens: 1, cache_creation_input_tokens: 30_000, cache_read_input_tokens: 0, output_tokens: 50 }));
  assert.deepEqual([trackerUsage(tracker).contextUsed, trackerUsage(tracker).contextSize], [30_001, 1_000_000]);

  // Kept across a restart.
  const restored = restoreTracker(JSON.parse(JSON.stringify(tracker)));
  assert.deepEqual([trackerUsage(restored).contextUsed, trackerUsage(restored).contextSize], [30_001, 1_000_000]);
});
