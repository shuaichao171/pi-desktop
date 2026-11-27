import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const { AgentPreferences } = await import('../packages/agent/src/acp/agentPreferences.ts');

test('agent preferences remember the last model and options per agent', (t) => {
	const root = mkdtempSync(join(tmpdir(), 'pi-agent-preferences-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const file = join(root, 'desktop-agent-preferences.json');
	const preferences = new AgentPreferences(file);
	assert.equal(preferences.get('claude-code'), null, 'nothing remembered yet');

	preferences.remember('claude-code', { model: 'opus' });
	preferences.remember('claude-code', { option: ['effort', 'high'] });
	preferences.remember('codex', { model: 'gpt-5' });
	assert.deepEqual(preferences.get('claude-code'), { model: 'opus', options: { effort: 'high' } });
	preferences.remember('claude-code', { model: 'sonnet' });
	assert.deepEqual(preferences.get('claude-code'), { model: 'sonnet', options: { effort: 'high' } }, 'a new model keeps the other choices');
	assert.deepEqual(preferences.get('codex'), { model: 'gpt-5', options: {} });

	// Another process (a split pane's agent host) writing in between is not overwritten.
	new AgentPreferences(file).remember('antigravity', { model: 'gemini' });
	preferences.remember('codex', { option: ['effort', 'low'] });
	assert.deepEqual(preferences.get('antigravity'), { model: 'gemini', options: {} });
	assert.deepEqual(preferences.get('codex'), { model: 'gpt-5', options: { effort: 'low' } });

	// Pi and invalid ids are never stored.
	preferences.remember('pi', { model: 'x' });
	preferences.remember('../escape', { model: 'x' });
	assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8')).agents).sort(), ['antigravity', 'claude-code', 'codex']);
});

test('a malformed preferences file means nothing is remembered, and oversized values are dropped', (t) => {
	const root = mkdtempSync(join(tmpdir(), 'pi-agent-preferences-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const file = join(root, 'desktop-agent-preferences.json');
	writeFileSync(file, '{ not json', 'utf8');
	const preferences = new AgentPreferences(file);
	assert.equal(preferences.get('codex'), null);
	preferences.remember('codex', { model: 'gpt-5' });
	assert.deepEqual(preferences.get('codex'), { model: 'gpt-5', options: {} }, 'a broken file is replaced on the next choice');

	writeFileSync(file, JSON.stringify({ version: 1, agents: { codex: { model: 'x'.repeat(501), options: { effort: 'high', bad: 7 } }, pi: { model: 'm', options: {} } } }), 'utf8');
	assert.deepEqual(preferences.get('codex'), { options: { effort: 'high' } });
	assert.equal(preferences.get('pi'), null);
});

test('agent preferences remember the last used agent across processes without losing per-agent settings', (t) => {
	const root = mkdtempSync(join(tmpdir(), 'pi-agent-preferences-last-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const file = join(root, 'desktop-agent-preferences.json');
	const preferences = new AgentPreferences(file);
	assert.equal(preferences.getLastAgent(), null, 'no agent remembered yet');

	preferences.remember('claude-code', { model: 'opus' });
	preferences.rememberLastAgent('claude-code');
	assert.equal(preferences.getLastAgent(), 'claude-code');
	assert.deepEqual(preferences.get('claude-code'), { model: 'opus', options: {} });

	// Updating per-agent settings keeps lastAgent intact, and another process sees it immediately.
	new AgentPreferences(file).remember('codex', { model: 'gpt-5' });
	assert.equal(preferences.getLastAgent(), 'claude-code');
	new AgentPreferences(file).rememberLastAgent('pi');
	assert.equal(preferences.getLastAgent(), 'pi', 'switching back to pi is remembered too');

	// Invalid ids are ignored, and malformed lastAgent fields are dropped without breaking agents.
	preferences.rememberLastAgent('../escape');
	assert.equal(preferences.getLastAgent(), 'pi');
	writeFileSync(file, JSON.stringify({ version: 1, lastAgent: 'INVALID!', agents: { codex: { model: 'gpt-5', options: {} } } }), 'utf8');
	assert.equal(preferences.getLastAgent(), null);
	assert.deepEqual(preferences.get('codex'), { model: 'gpt-5', options: {} });
});
