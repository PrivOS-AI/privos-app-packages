/**
 * Host-brokered microphone and wake lock on the default app: the request/notification wire format
 * and the routing of streamed PCM frames. jsdom makes `window.parent === window`, so requests are
 * captured by spying on `window.postMessage` and host replies are dispatched with `source: window`.
 */
import { cleanup, renderHook } from '@testing-library/react';
import { createElement } from 'react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PrivosAppProvider } from './PrivosAppProvider';
import type { McpApp } from './PrivosAppProvider';
import { usePrivosApp } from './use-privos-app';

const fromHost = (data: unknown) => {
	const event = new MessageEvent('message', { data });
	Object.defineProperty(event, 'source', { value: window });
	window.dispatchEvent(event);
};

const initialize = (hostCapabilities: Record<string, unknown>) =>
	fromHost({ jsonrpc: '2.0', method: 'ui/initialize', params: { hostCapabilities } });

let sent: any[];
let app: McpApp;

beforeEach(() => {
	sent = [];
	vi.spyOn(window, 'postMessage').mockImplementation((message: any) => {
		sent.push(message);
	});
	initialize({ microphone: true, wakeLock: true });
	const wrapper = ({ children }: { children: ReactNode }) => createElement(PrivosAppProvider, null, children);
	app = renderHook(() => usePrivosApp(), { wrapper }).result.current;
});

afterEach(() => {
	// Unmount so each test's app is the only one listening to host messages.
	cleanup();
	vi.restoreAllMocks();
});

/** Answer the last request the app sent. */
const reply = (result: unknown) => fromHost({ jsonrpc: '2.0', id: sent[sent.length - 1].id, result });

describe('startMicrophone', () => {
	it('asks the host, then routes PCM frames for its stream until stopped', async () => {
		const onData = vi.fn();
		const pending = app.startMicrophone!({ sampleRate: 16000, onData });

		expect(sent[0]).toMatchObject({ method: 'host/microphone.start', params: { sampleRate: 16000 } });
		expect(sent[0].params).not.toHaveProperty('onData');
		reply({ granted: true, streamId: 'mic-1', sampleRate: 16000, encoding: 'pcm_s16le', channels: 1 });
		const result = await pending;
		expect(result).toMatchObject({ granted: true, streamId: 'mic-1', sampleRate: 16000 });

		const pcm = new Int16Array([1, -2, 3]).buffer;
		fromHost({ jsonrpc: '2.0', method: 'ui/microphone.data', params: { streamId: 'mic-1', pcm } });
		fromHost({ jsonrpc: '2.0', method: 'ui/microphone.data', params: { streamId: 'other', pcm } });
		expect(onData).toHaveBeenCalledTimes(1);
		expect(Array.from(onData.mock.calls[0][0] as Int16Array)).toEqual([1, -2, 3]);

		if (result.granted) result.stop();
		expect(sent[sent.length - 1]).toEqual({ jsonrpc: '2.0', method: 'host/microphone.stop', params: { streamId: 'mic-1' } });
		fromHost({ jsonrpc: '2.0', method: 'ui/microphone.data', params: { streamId: 'mic-1', pcm } });
		expect(onData).toHaveBeenCalledTimes(1);
	});

	it('passes a host refusal through as a reason', async () => {
		const pending = app.startMicrophone!({ onData: vi.fn() });
		reply({ granted: false, reason: 'user_activation_required' });
		expect(await pending).toEqual({ granted: false, reason: 'user_activation_required' });
	});

	it('reports a capture the host ended', async () => {
		const onEnded = vi.fn();
		const pending = app.startMicrophone!({ onData: vi.fn(), onEnded });
		reply({ granted: true, streamId: 'mic-2', sampleRate: 48000, encoding: 'pcm_s16le', channels: 1 });
		await pending;

		fromHost({ jsonrpc: '2.0', method: 'ui/microphone.ended', params: { streamId: 'mic-2', reason: 'device_ended' } });
		expect(onEnded).toHaveBeenCalledWith('device_ended');
	});

	it('ends a replaced capture through its own onEnded, keeping the new one live', async () => {
		const first = { onData: vi.fn(), onEnded: vi.fn() };
		const second = { onData: vi.fn(), onEnded: vi.fn() };
		const a = app.startMicrophone!(first);
		reply({ granted: true, streamId: 'mic-1', sampleRate: 16000, encoding: 'pcm_s16le', channels: 1 });
		await a;
		const b = app.startMicrophone!(second);
		fromHost({ jsonrpc: '2.0', method: 'ui/microphone.ended', params: { streamId: 'mic-1', reason: 'replaced' } });
		reply({ granted: true, streamId: 'mic-2', sampleRate: 16000, encoding: 'pcm_s16le', channels: 1 });
		await b;

		expect(first.onEnded).toHaveBeenCalledWith('replaced');
		fromHost({ jsonrpc: '2.0', method: 'ui/microphone.data', params: { streamId: 'mic-2', pcm: new ArrayBuffer(2) } });
		expect(second.onData).toHaveBeenCalledTimes(1);
		expect(second.onEnded).not.toHaveBeenCalled();
	});

	it('hands back a grant that arrives after the start timed out', () => {
		fromHost({ jsonrpc: '2.0', id: 999, result: { granted: true, streamId: 'mic-9', sampleRate: 16000 } });
		expect(sent).toEqual([{ jsonrpc: '2.0', method: 'host/microphone.stop', params: { streamId: 'mic-9' } }]);
	});

	it('answers unsupported_host without a round trip on a hub that predates brokering', async () => {
		initialize({ tools: true });
		expect(await app.startMicrophone!({ onData: vi.fn() })).toEqual({ granted: false, reason: 'unsupported_host' });
		expect(await app.requestWakeLock!()).toEqual({ granted: false, reason: 'unsupported_host' });
		expect(sent).toEqual([]);
	});
});

describe('wake lock', () => {
	it('requests and releases through the host', async () => {
		const pending = app.requestWakeLock!();
		expect(sent[0]).toMatchObject({ method: 'host/wakeLock.request' });
		reply({ granted: true });
		expect(await pending).toEqual({ granted: true });

		app.releaseWakeLock!();
		expect(sent[sent.length - 1]).toEqual({ jsonrpc: '2.0', method: 'host/wakeLock.release', params: {} });
	});

	it('re-requests a wanted lock after the host reinitializes the frame, and not after release', async () => {
		const pending = app.requestWakeLock!();
		reply({ granted: true });
		await pending;

		sent = [];
		initialize({ microphone: true, wakeLock: true });
		expect(sent).toEqual([expect.objectContaining({ method: 'host/wakeLock.request' })]);

		app.releaseWakeLock!();
		sent = [];
		initialize({ microphone: true, wakeLock: true });
		expect(sent).toEqual([]);
	});
});
