import { describe, expect, it } from 'vitest';
import { buildDetachedArgv, detachedLogPath, DETACH_FLAG } from '../src/start-detach.js';

describe('start --detach argv rewrite', () => {
	it('drops only --detach so the child serves in the foreground of its own session', () => {
		const argv = ['start', '--agent', 'abc123', '--adapter', 'custom', '--command', 'openclaw acp', DETACH_FLAG, '--isolation', 'prompt'];
		expect(buildDetachedArgv(argv)).toEqual(['start', '--agent', 'abc123', '--adapter', 'custom', '--command', 'openclaw acp', '--isolation', 'prompt']);
	});

	it('never re-detaches: the rewritten argv carries no --detach even if it was passed twice', () => {
		expect(buildDetachedArgv(['start', DETACH_FLAG, DETACH_FLAG])).toEqual(['start']);
	});

	it('leaves an argv without --detach untouched', () => {
		const argv = ['start', '--agent', 'abc123'];
		expect(buildDetachedArgv(argv)).toEqual(argv);
	});

	it('logs next to the rooms of the agent workspace', () => {
		expect(detachedLogPath('/home/op/privos-harness/abc123')).toBe('/home/op/privos-harness/abc123/bridge.log');
	});
});
