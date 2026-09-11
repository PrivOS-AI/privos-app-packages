import { describe, expect, it } from 'vitest';

import { parseScaffoldArgs } from '../src/cli-args';

describe('parseScaffoldArgs', () => {
	it('defaults to no template flag', () => {
		expect(parseScaffoldArgs(['my-app'])).toEqual({ appName: 'my-app', template: undefined });
	});

	it('parses a space-separated --template flag', () => {
		expect(parseScaffoldArgs(['my-app', '--template', 'instant'])).toEqual({ appName: 'my-app', template: 'instant' });
	});

	it('parses a --template=value flag', () => {
		expect(parseScaffoldArgs(['my-app', '--template=instant'])).toEqual({ appName: 'my-app', template: 'instant' });
	});

	it('parses the flag before the positional app name', () => {
		expect(parseScaffoldArgs(['--template', 'instant', 'my-app'])).toEqual({ appName: 'my-app', template: 'instant' });
	});

	it('yields an empty-string template (not undefined) for a trailing flag with no value', () => {
		expect(parseScaffoldArgs(['my-app', '--template'])).toEqual({ appName: 'my-app', template: '' });
	});

	it('yields no app name when only the template flag is given', () => {
		expect(parseScaffoldArgs(['--template', 'instant'])).toEqual({ appName: undefined, template: 'instant' });
	});
});
