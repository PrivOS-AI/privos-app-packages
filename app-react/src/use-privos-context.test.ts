/**
 * `usePrivosContext` keeps only the host-context fields it knows, so a field the Hub adds is
 * invisible to apps until it is merged here. Pins how `locale` arrives and survives later pushes
 * and the `mcpapp.context.get` refresh, which never carries it.
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { createElement } from 'react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PrivosAppContext } from './PrivosAppProvider';
import type { McpApp } from './PrivosAppProvider';
import { usePrivosContext } from './use-privos-context';

const renderContext = (contextGetResult: Record<string, unknown> = {}) => {
	let resolveContextGet: (value: unknown) => void = () => undefined;
	const app = {
		onhostcontextchanged: undefined as ((ctx: Record<string, unknown>) => void) | undefined,
		callServerTool: vi.fn(
			() =>
				new Promise((resolve) => {
					resolveContextGet = resolve;
				}),
		),
	};
	const wrapper = ({ children }: { children: ReactNode }) =>
		createElement(PrivosAppContext.Provider, { value: app as unknown as McpApp }, children);
	const { result } = renderHook(() => usePrivosContext(), { wrapper });
	return {
		result,
		push: (ctx: Record<string, unknown>) => act(() => app.onhostcontextchanged?.(ctx)),
		finishContextGet: () =>
			act(async () => {
				resolveContextGet({ content: [{ type: 'text', text: JSON.stringify(contextGetResult) }] });
			}),
	};
};

afterEach(() => cleanup());

describe('usePrivosContext locale', () => {
	it('is undefined until a host sends one', () => {
		expect(renderContext().result.current.locale).toBeUndefined();
	});

	it('exposes the pushed locale and follows a language switch', () => {
		const { result, push } = renderContext();

		push({ theme: 'light', locale: 'vi-VN' });
		expect(result.current.locale).toBe('vi-VN');

		push({ theme: 'light', locale: 'en' });
		expect(result.current.locale).toBe('en');
	});

	it('keeps the locale through a later push and the context.get refresh that omit it', async () => {
		const { result, push, finishContextGet } = renderContext({ roomId: 'r1', roomName: 'general' });

		push({ theme: 'dark', locale: 'vi-VN' });
		push({ theme: 'light' });
		await finishContextGet();

		expect(result.current.locale).toBe('vi-VN');
		expect(result.current.roomName).toBe('general');
	});

	it('ignores a non-string locale', () => {
		const { result, push } = renderContext();

		push({ locale: 42 });
		expect(result.current.locale).toBeUndefined();
	});
});
