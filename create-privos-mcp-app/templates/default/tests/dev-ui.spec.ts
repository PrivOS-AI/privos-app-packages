import { describe, expect, it } from 'vitest';

import { devUiHtml, resolveDevUiOrigin } from '../src/dev-ui';

describe('dev UI page', () => {
  it('loads the Vite client, the React refresh preamble and the entry module from the origin', () => {
    const html = devUiHtml('https://dev.example.com/', 'My app');
    expect(html).toContain('src="https://dev.example.com/@vite/client"');
    expect(html).toContain('import RefreshRuntime from "https://dev.example.com/@react-refresh"');
    expect(html).toContain('window.__vite_plugin_react_preamble_installed__ = true');
    expect(html).toContain('src="https://dev.example.com/main.tsx"');
  });

  it('escapes the title', () => {
    expect(devUiHtml('http://localhost:5173', '<script>alert(1)</script>')).not.toContain('<script>alert(1)');
  });
});

describe('resolveDevUiOrigin', () => {
  it('defaults to the local Vite server', () => {
    expect(resolveDevUiOrigin({}).origin).toBe('http://localhost:5173');
  });

  it('takes PRIVOS_DEV_UI_ORIGIN, for a forwarded or tunnelled port', () => {
    expect(resolveDevUiOrigin({ PRIVOS_DEV_UI_ORIGIN: 'https://dev.example.com' }).origin).toBe('https://dev.example.com');
  });

  it.each(['not a url', 'ftp://dev.example.com', 'https://dev.example.com/some/path', 'https://dev.example.com/?x=1'])(
    'rejects %s',
    (value) => {
      expect(() => resolveDevUiOrigin({ PRIVOS_DEV_UI_ORIGIN: value })).toThrow(/PRIVOS_DEV_UI_ORIGIN/);
    },
  );
});
