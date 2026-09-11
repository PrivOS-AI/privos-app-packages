import { describe, expect, it } from 'vitest';
import { buildSystemdUnit, defaultUnitName } from '../src/service-install.js';

describe('buildSystemdUnit', () => {
	const base = {
		agentId: 'abc123',
		nodePath: '/home/roxane/.nvm/versions/node/v22.16.0/bin/node',
		scriptPath: '/home/roxane/.nvm/versions/node/v22.16.0/lib/node_modules/@privos_ai/agent-harness/dist/cli.js',
		startArgs: ['start', '--agent', 'abc123', '--isolation', 'prompt', '--permissions', 'safe'],
		pathDirs: ['/home/roxane/.nvm/versions/node/v22.16.0/bin', '/usr/bin'],
		envFile: '/home/roxane/.config/privos-agent-harness-abc123.env',
	};

	it('embeds ExecStart as node + script + args, and a non-fatal EnvironmentFile', () => {
		const unit = buildSystemdUnit(base);
		expect(unit).toContain(`ExecStart=${base.nodePath} ${base.scriptPath} start --agent abc123 --isolation prompt --permissions safe`);
		expect(unit).toContain(`EnvironmentFile=-${base.envFile}`);
		expect(unit).toContain('Restart=on-failure');
		expect(unit).toContain('WantedBy=default.target');
	});

	it('dedupes PATH dirs (caller dir already in defaults) and keeps order', () => {
		const unit = buildSystemdUnit({ ...base, pathDirs: ['/usr/bin', '/opt/adapter/bin'] });
		expect(unit).toContain('Environment=PATH=/usr/bin:/opt/adapter/bin:/usr/local/bin:/bin');
	});

	it('quotes an ExecStart arg containing spaces', () => {
		const unit = buildSystemdUnit({ ...base, startArgs: ['start', '--command', 'agy-acp --flag x'] });
		expect(unit).toContain('ExecStart=' + base.nodePath + ' ' + base.scriptPath + ' start --command "agy-acp --flag x"');
	});

	it('defaultUnitName is filesystem-safe and agent-scoped', () => {
		expect(defaultUnitName('abc/123')).toBe('privos-agent-harness-abc-123');
	});
});
