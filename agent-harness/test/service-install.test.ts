import { describe, expect, it } from 'vitest';
import { buildServiceStartArgs, buildSystemdUnit, defaultUnitName } from '../src/service-install.js';

describe('buildServiceStartArgs', () => {
	const base = { agentId: 'abc123', adapter: 'claude', isolation: 'auto', permissions: 'safe', maxRooms: 8, idleTimeout: 600 };

	it('spells out every default so the unit documents how the service runs', () => {
		expect(buildServiceStartArgs(base)).toEqual([
			'start',
			'--agent',
			'abc123',
			'--adapter',
			'claude',
			'--isolation',
			'auto',
			'--permissions',
			'safe',
			'--max-rooms',
			'8',
			'--idle-timeout',
			'600',
		]);
	});

	it('keeps a custom adapter command as one argv token and only bakes the image in for container isolation', () => {
		const custom = buildServiceStartArgs({ ...base, adapter: 'custom', command: 'openclaw acp', containerImage: 'node:22-bookworm' });
		expect(custom[custom.indexOf('--command') + 1]).toBe('openclaw acp');
		expect(custom).not.toContain('--container-image');
		const container = buildServiceStartArgs({ ...base, isolation: 'container', containerImage: 'node:22-bookworm' });
		expect(container.slice(container.indexOf('--container-image'))).toEqual(['--container-image', 'node:22-bookworm']);
	});

	it('forwards the optional start flags verbatim', () => {
		const args = buildServiceStartArgs({ ...base, workspace: '/srv/ws', insecure: true, noSkills: true, skillsDir: '/src/sandbox' });
		expect(args).toEqual(expect.arrayContaining(['--workspace', '/srv/ws', '--insecure', '--no-skills', '--skills-dir', '/src/sandbox']));
	});
});

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

	it('puts the start-rate limit in [Unit], where systemd reads it (in [Service] it logs "Unknown key name")', () => {
		const unit = buildSystemdUnit(base);
		const unitSection = unit.slice(unit.indexOf('[Unit]'), unit.indexOf('[Service]'));
		expect(unitSection).toContain('StartLimitIntervalSec=60');
		expect(unitSection).toContain('StartLimitBurst=5');
		expect(unit.slice(unit.indexOf('[Service]'))).not.toContain('StartLimit');
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
