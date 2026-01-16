import { spawnSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import test from 'tape';

const __dirname = dirname(fileURLToPath(import.meta.url));
const binPath = join(__dirname, '..', 'bin.mjs');

/** @param {string[]} args */
const runCli = function (args) {
	const result = spawnSync(process.execPath, [binPath, ...args], {
		encoding: 'utf8',
		timeout: 30000,
	});
	return {
		exitCode: result.status,
		stderr: result.stderr,
		stdout: result.stdout,
	};
};

test('reprogistry CLI', (t) => {
	t.test('shows help with --help', (st) => {
		const result = runCli(['--help']);
		st.equal(result.exitCode, 0, 'exits with 0');
		st.ok(result.stdout.includes('reprogistry'), 'output includes package name');
		st.ok(result.stdout.includes('--json'), 'output includes --json option');
		st.ok(result.stdout.includes('--purl'), 'output includes --purl option');
		st.end();
	});

	t.test('errors with no arguments', (st) => {
		const result = runCli([]);
		st.equal(result.exitCode, 1, 'exits with 1');
		st.ok(result.stderr.includes('required'), 'shows error about required argument');
		st.end();
	});

	t.test('errors on invalid PURL', (st) => {
		const result = runCli(['--purl', 'invalid']);
		st.equal(result.exitCode, 1, 'exits with 1');
		st.ok(result.stderr.includes('Invalid PURL'), 'shows invalid PURL error');
		st.end();
	});

	t.test('errors on non-npm PURL', (st) => {
		const result = runCli(['--purl', 'pkg:pypi/requests@2.0.0']);
		st.equal(result.exitCode, 1, 'exits with 1');
		st.ok(result.stderr.includes('Only npm PURLs are supported'), 'shows non-npm error');
		st.end();
	});

	/*
	 * Network-dependent tests - these test the actual CLI behavior
	 * They require network access to npm registry and GitHub raw content
	 */
	t.test('handles untracked package gracefully', (st) => {
		const result = runCli(['nonexistent-package-xyz-123@1.0.0']);
		st.equal(result.exitCode, 0, 'exits with 0');
		st.ok(
			result.stdout.includes('Package: nonexistent-package-xyz-123'),
			'shows package name',
		);
		st.ok(
			result.stdout.includes('Not tracked'),
			'shows not tracked status',
		);
		st.end();
	});

	t.test('outputs JSON with --json flag for untracked package', (st) => {
		const result = runCli(['--json', 'nonexistent-package-xyz-123@1.0.0']);
		st.equal(result.exitCode, 0, 'exits with 0');
		let parsed;
		try {
			parsed = JSON.parse(result.stdout);
		} catch {
			st.fail('output is not valid JSON');
		}
		st.ok(parsed, 'output parses as JSON');
		st.equal(parsed.name, 'nonexistent-package-xyz-123', 'JSON has correct name');
		st.equal(parsed.status, 'not-tracked', 'JSON has not-tracked status');
		st.end();
	});

	t.test('looks up tracked package', (st) => {
		const result = runCli(['is-callable@1.2.7']);
		st.equal(result.exitCode, 0, 'exits with 0');
		st.ok(result.stdout.includes('Package: is-callable'), 'shows package name');
		st.ok(result.stdout.includes('Version: 1.2.7'), 'shows version');
		st.ok(result.stdout.includes('Reproducibility:'), 'shows reproducibility');
		st.ok((/Reproducibility: \d+\.\d+%/).test(result.stdout), 'shows reproducibility as percentage');
		st.ok((/\(Perfect\)|\(Excellent\)|\(Good\)|\(High Risk\)/).test(result.stdout), 'shows tier in parentheses');
		st.end();
	});

	t.test('shows transitive dependencies label', (st) => {
		const result = runCli(['@babel/code-frame@7.8.3']);
		st.equal(result.exitCode, 0, 'exits with 0');
		st.ok(result.stdout.includes('Transitive Dependencies:'), 'shows transitive dependencies');
		st.notOk(result.stdout.includes('Direct Dependencies:'), 'does not say direct dependencies');
		st.end();
	});

	t.test('outputs JSON with tier and dependencies for tracked package', (st) => {
		const result = runCli(['--json', 'is-callable@1.2.7']);
		st.equal(result.exitCode, 0, 'exits with 0');
		let parsed;
		try {
			parsed = JSON.parse(result.stdout);
		} catch {
			st.fail('output is not valid JSON');
		}
		st.ok(parsed, 'output parses as JSON');
		st.equal(parsed.name, 'is-callable', 'JSON has correct name');
		st.equal(parsed.version, '1.2.7', 'JSON has correct version');
		st.equal(typeof parsed.score, 'number', 'JSON has numeric score');
		st.ok(['Perfect', 'Excellent', 'Good', 'High Risk'].includes(parsed.tier), 'JSON has valid tier');
		st.ok(parsed.dependencies, 'JSON has dependencies object');
		st.equal(typeof parsed.dependencies.total, 'number', 'dependencies has total count');
		st.equal(typeof parsed.dependencies.tracked, 'number', 'dependencies has tracked count');
		st.equal(typeof parsed.dependencies.missing, 'number', 'dependencies has missing count');
		st.end();
	});

	t.test('resolves version ranges', (st) => {
		const result = runCli(['--json', 'is-callable@^1.2.0']);
		st.equal(result.exitCode, 0, 'exits with 0');
		let parsed;
		try {
			parsed = JSON.parse(result.stdout);
		} catch {
			st.fail('output is not valid JSON');
		}
		st.ok(parsed, 'output parses as JSON');
		st.equal(parsed.name, 'is-callable', 'JSON has correct name');
		st.ok(parsed.version.startsWith('1.'), 'resolved version starts with 1.');
		st.end();
	});

	t.test('handles npm PURL', (st) => {
		const result = runCli(['--purl', 'pkg:npm/is-callable@1.2.7']);
		st.equal(result.exitCode, 0, 'exits with 0');
		st.ok(result.stdout.includes('Package: is-callable'), 'shows package name');
		st.ok(result.stdout.includes('Version: 1.2.7'), 'shows version');
		st.end();
	});

	t.test('handles scoped package PURL', (st) => {
		const result = runCli(['--purl', 'pkg:npm/%40types/node@22.0.0']);
		st.equal(result.exitCode, 0, 'exits with 0');
		st.ok(result.stdout.includes('Package: @types/node'), 'shows scoped package name');
		st.end();
	});

	t.end();
});
