/**
 * Local reproduce module - inlined and modified from the `reproduce` package.
 * This allows for customization to support version-aware reproduction.
 *
 * Original: https://github.com/vltpkg/reproduce
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import {
	homedir,
	platform,
} from 'os';
import { join as pathJoin } from 'path';

import pacote from 'pacote';
const { manifest, packument } = pacote;
import {
	coerce,
	lt,
	gte,
} from 'semver';

import pkg from '../package.json' with { type: 'json' };

// npm >= 5.0.0 supports --before flag for time-based dependency resolution
const NPM_BEFORE_VERSION = '5.0.0';

const depTypes = [
	'dependencies',
	'devDependencies',
	'peerDependencies',
	'optionalDependencies',
];

/**
 * Rewrite workspace: protocol dependencies to use * instead.
 * This allows npm to install monorepo packages that use yarn/pnpm workspaces.
 *
 * @param {string} packageDir - Directory containing package.json
 */
async function rewriteWorkspaceDeps(packageDir) {
	const pkgPath = pathJoin(packageDir, 'package.json');
	const pkgJson = JSON.parse(await readFile(pkgPath, 'utf8'));
	let modified = false;

	for (const depType of depTypes) {
		const deps = pkgJson[depType];
		if (deps) {
			for (const [name, version] of Object.entries(deps)) {
				if (typeof version === 'string' && version.startsWith('workspace:')) {
					deps[name] = '*';
					modified = true;
				}
			}
		}
	}

	if (modified) {
		await writeFile(pkgPath, JSON.stringify(pkgJson, null, 2));
	}
}

// Minimum Node.js version that can be installed via nvm in GitHub Actions
const MIN_NODE_VERSION = '0.8.0';

// NVM_DIR for nvm integration
const NVM_DIR = process.env.NVM_DIR || pathJoin(homedir(), '.nvm');
const NVM_SCRIPT = pathJoin(NVM_DIR, 'nvm.sh');

const DEFAULT_CACHE_DIR = (() => {
	switch (platform()) {
		case 'darwin':
			return pathJoin(homedir(), 'Library', 'Caches', 'reproduce');
		case 'win32':
			return pathJoin(homedir(), 'AppData', 'Local', 'reproduce', 'Cache');
		default:
			return pathJoin(process.env.XDG_CACHE_HOME || pathJoin(homedir(), '.cache'), 'reproduce');
	}
})();

const DEFAULT_CACHE_FILE = 'cache.json';

/** @type {import('child_process').ExecSyncOptions} */
const EXEC_OPTIONS = {
	stdio: ['pipe', 'pipe', 'pipe'],
};

/**
 * @param {string} command
 * @param {import('child_process').ExecSyncOptions} [options]
 * @returns {string}
 */
function exec(command, options) {
	return String(execSync(command, { ...EXEC_OPTIONS, ...options })).trim();
}

/** @returns {boolean} */
function isNvmAvailable() {
	return existsSync(NVM_SCRIPT);
}

/**
 * Execute a command with a specific Node version using nvm-exec.
 *
 * @param {string} nodeVersion
 * @param {string} command
 * @param {import('child_process').ExecSyncOptions} [options]
 * @returns {string}
 */
function execWithNodeVersion(nodeVersion, command, options) {
	const version = nodeVersion.replace(/^v/, '');
	// Use nvm exec which handles version switching more reliably
	const nvmCmd = `source "${NVM_SCRIPT}" && nvm exec ${version} ${command}`;

	return String(execSync(nvmCmd, {
		...EXEC_OPTIONS,
		...options,
		shell: '/bin/bash',
	})).trim();
}

/**
 * Extract just the version number from nvm output.
 * nvm exec outputs things like "Running node v0.12.18 (npm v2.15.11)\nv0.12.18"
 *
 * @param {string} output
 * @returns {string}
 */
function extractNodeVersion(output) {
	// Look for a line that is just a version number (vX.Y.Z or X.Y.Z)
	const lines = output.split('\n').map((l) => l.trim());
	for (const line of lines) {
		// Match version patterns like "v0.12.18" or "0.12.18"
		if ((/^v?\d+\.\d+\.\d+/).test(line)) {
			return line.replace(/^v/, '');
		}
	}
	// Fallback: try to extract from "Running node vX.Y.Z" pattern
	const match = output.match(/node v?(?<ver>\d+\.\d+\.\d+)/i);
	if (match?.groups) {
		return match.groups.ver;
	}
	return output.trim().replace(/^v/, '');
}

/**
 * @param {string} version
 * @returns {string | null}
 */
function tryInstallNode(version) {
	try {
		// Try to install directly - nvm will use cached version if already installed
		console.log(`  -> Installing node ${version} via nvm...`);
		execSync(
			`source "${NVM_SCRIPT}" && nvm install ${version} 2>/dev/null`,
			{ ...EXEC_OPTIONS, shell: '/bin/bash' },
		);

		// Verify it's actually usable - nvm exec outputs extra info, so extract just the version
		const rawOutput = execSync(
			`source "${NVM_SCRIPT}" && nvm exec ${version} node --version 2>/dev/null`,
			{ ...EXEC_OPTIONS, shell: '/bin/bash' },
		).toString();

		const installedVersion = extractNodeVersion(rawOutput);
		return installedVersion;
	} catch (err) {
		console.error(`  -> Failed to install node ${version}: ${/** @type {Error} */ (err).message}`);
		return null;
	}
}

/**
 * @param {string} nodeVersion
 * @returns {string | null}
 */
function ensureNodeVersion(nodeVersion) {
	if (!isNvmAvailable()) {
		return null;
	}

	const version = nodeVersion.replace(/^v/, '');
	const coerced = coerce(version);
	const major = coerced ? coerced.major : null;

	// Try exact version first
	let installed = tryInstallNode(version);
	if (installed) {
		return installed;
	}

	// If exact version failed, try major.x (latest in that major line)
	if (major !== null) {
		console.log(`  -> Exact version ${version} unavailable, trying node ${major} (latest)...`);
		installed = tryInstallNode(String(major));
		if (installed) {
			return installed;
		}

		// If that failed too, try next major version
		const nextMajor = major + 1;
		console.log(`  -> Node ${major} unavailable, trying node ${nextMajor}...`);
		installed = tryInstallNode(String(nextMajor));
		if (installed) {
			return installed;
		}
	}

	console.error(`  -> Could not install any compatible node version for ${version}`);
	return null;
}

/**
 * @param {string | null} [nodeVersion]
 * @returns {string}
 */
function getNpmVersion(nodeVersion) {
	if (nodeVersion && isNvmAvailable()) {
		try {
			return execWithNodeVersion(nodeVersion, 'npm --version');
		} catch {
			// Fall back to current npm
		}
	}
	return exec('npm --version');
}

/**
 * @param {string} dir
 * @param {{ before?: string, nodeVersion?: string | null, npmVersion?: string }} [options]
 */
function npmInstall(dir, options = {}) {
	let cmd = 'npm install --ignore-scripts --no-audit --no-fund --legacy-peer-deps --force';

	if (!options.before) {
		throw new Error('npmInstall requires a --before timestamp for reproducible builds');
	}

	if (!options.npmVersion) {
		throw new Error('npmInstall requires npmVersion to verify --before support');
	}

	if (!gte(options.npmVersion, NPM_BEFORE_VERSION)) {
		throw new Error(`npm version ${options.npmVersion} does not support --before (requires >= ${NPM_BEFORE_VERSION})`);
	}

	cmd += ` --before="${options.before}"`;
	console.log(`  -> Using --before="${options.before}" with npm ${options.npmVersion}`);

	// Set NPM_CONFIG_BEFORE env var for transitive npm calls (e.g., prepack scripts)
	const envWithBefore = { ...process.env, NPM_CONFIG_BEFORE: options.before };

	const fullCmd = `cd "${dir}" && ${cmd}`;

	if (options.nodeVersion && isNvmAvailable()) {
		try {
			execWithNodeVersion(options.nodeVersion, fullCmd, { env: envWithBefore });
			return;
		} catch (e) {
			console.error(`  -> Failed with node ${options.nodeVersion}, falling back to current: ${/** @type {Error} */ (e).message}`);
		}
	}

	exec(fullCmd, { env: envWithBefore });
}

/**
 * @param {string} dir
 * @param {{ before?: string, nodeVersion?: string | null }} [options]
 * @returns {{ integrity?: string }}
 */
function npmPack(dir, options = {}) {
	const cmd = `cd "${dir}" && npm pack --dry-run --json`;

	// Set NPM_CONFIG_BEFORE env var for prepack scripts
	const packEnv = options.before
		? { ...process.env, NPM_CONFIG_BEFORE: options.before }
		: undefined;

	if (packEnv) {
		console.log(`  -> npm pack using NPM_CONFIG_BEFORE="${options.before}"`);
	}

	const execOpts = packEnv ? { env: packEnv } : {};
	let output;

	if (options.nodeVersion && isNvmAvailable()) {
		try {
			output = execWithNodeVersion(options.nodeVersion, cmd, execOpts);
		} catch (e) {
			console.error(`  -> npm pack failed with node ${options.nodeVersion}, falling back to current: ${/** @type {Error} */ (e).message}`);
			output = exec(cmd, execOpts);
		}
	} else {
		output = exec(cmd, execOpts);
	}

	return JSON.parse(output)[0];
}

/**
 * @typedef {Object} ReproduceOptions
 * @property {Record<string, unknown>} [cache]
 * @property {string} [cacheDir]
 * @property {string} [cacheFile]
 * @property {string} [strategy]
 * @property {boolean} [force]
 */

/**
 * @typedef {Object} ReproduceResult
 * @property {string} reproduceVersion
 * @property {string} timestamp
 * @property {string} os
 * @property {string} arch
 * @property {string} strategy
 * @property {boolean} reproduced
 * @property {boolean} attested
 * @property {{ spec: string, name: string, version: string, location: string, integrity: string, publishedAt: string | null, publishedWith: { node: string | null, npm: string | null }, dependencies: Record<string, string> }} package
 * @property {{ integrity: string | null, location: string, spec: string }} source
 */

/**
 * @param {string} spec
 * @param {ReproduceOptions} [opts]
 * @returns {Promise<false | ReproduceResult>}
 */
export default async function reproduce(spec, opts) {
	const mergedOpts = {
		cache: /** @type {Record<string, unknown>} */ ({}),
		cacheDir: DEFAULT_CACHE_DIR,
		cacheFile: DEFAULT_CACHE_FILE,
		strategy: 'npm',
		...opts,
	};

	const cacheFilePath = pathJoin(mergedOpts.cacheDir, mergedOpts.cacheFile);

	if (!existsSync(cacheFilePath)) {
		await mkdir(mergedOpts.cacheDir, { recursive: true });
		await writeFile(cacheFilePath, JSON.stringify(mergedOpts.cache));
	}

	if (Object.keys(mergedOpts.cache).length === 0) {
		mergedOpts.cache = JSON.parse(await readFile(cacheFilePath, 'utf8'));
	}

	if (!mergedOpts.force && Object.hasOwn(mergedOpts.cache, spec)) {
		return /** @type {false | ReproduceResult} */ (mergedOpts.cache[spec]);
	}

	try {
		const mani = await manifest(spec, { fullMetadata: true });

		if (!mani || !mani.repository || !mani.repository.url) {
			return false;
		}

		const { repository: repo } = mani;
		const { url } = /** @type {{ url: string, directory?: string }} */ (repo);

		let parsed;
		try {
			const normalizedUrl = url
				.replace(/^git\+/, '')
				.replace(/^git:\/\//, 'https://')
				.replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/')
				.replace(/^git@github\.com:/, 'https://github.com/');
			parsed = new URL(normalizedUrl);
		} catch {
			return false;
		}

		if (parsed.host !== 'github.com') {
			return false;
		}

		// Extract repo path and handle /tree/ and /blob/ URLs (monorepos)
		let pathname = parsed.pathname.replace('.git', '').replace(/^\//, '');
		let extractedSubdir = null;

		// Handle GitHub /tree/branch/path and /blob/branch/path URLs
		const treeMatch = pathname.match(/^(?<repo>[^/]+\/[^/]+)\/(?:tree|blob)\/[^/]+\/(?<subdir>.+)$/);
		if (treeMatch?.groups) {
			pathname = treeMatch.groups.repo;
			extractedSubdir = treeMatch.groups.subdir;
		} else {
			// Also strip just /tree/branch or /blob/branch without subdir
			const branchMatch = pathname.match(/^(?<repo>[^/]+\/[^/]+)\/(?:tree|blob)\/[^/]+$/);
			if (branchMatch?.groups) {
				pathname = branchMatch.groups.repo;
			}
		}

		const location = pathname;
		// Use repo.directory if provided, otherwise use extracted subdir from URL
		const effectiveDirectory = repo.directory || extractedSubdir;
		const repoPath = effectiveDirectory ? `::path:${effectiveDirectory}` : '';

		// Determine git ref: prefer gitHead, then try version tags, finally fallback to HEAD
		let ref = mani.gitHead;
		if (!ref) {
			// Try to find a matching tag (v1.2.3 or 1.2.3)
			const tagRef = `v${mani.version}`;
			try {
				const tagCheck = exec(`git ls-remote --tags "https://github.com/${location}.git" "${tagRef}" "${mani.version}" 2>/dev/null || true`);
				if (tagCheck) {
					const lines = tagCheck.split('\n').filter(Boolean);
					if (lines.length > 0) {
						// Prefer exact version tag over v-prefixed
						const exactMatch = lines.find((l) => l.endsWith(`refs/tags/${mani.version}`));
						const vMatch = lines.find((l) => l.endsWith(`refs/tags/v${mani.version}`));
						if (exactMatch) {
							ref = mani.version;
							console.log(`  -> Using git tag: ${ref}`);
						} else if (vMatch) {
							ref = `v${mani.version}`;
							console.log(`  -> Using git tag: ${ref}`);
						}
					}
				}
			} catch {
				// Ignore tag lookup failures
			}
		}
		if (!ref) {
			ref = 'HEAD';
			console.log('  -> Warning: No gitHead or version tag found, using HEAD');
		}

		const source = `github:${location}#${ref}${repoPath}`;

		/** @type {{ integrity?: string }} */
		let packed = {};
		const repoCacheDir = pathJoin(mergedOpts.cacheDir, mani.name.replace('/', '__'));

		let originalNodeVersion = /** @type {string | undefined} */ (mani._nodeVersion) || null;
		/** @type {string | null} */
		let installedNodeVersion = null;

		// Clamp node version to minimum installable version
		const coercedVersion = originalNodeVersion ? coerce(originalNodeVersion) : null;
		if (originalNodeVersion && coercedVersion && lt(coercedVersion, MIN_NODE_VERSION)) {
			console.log(`  -> Node ${originalNodeVersion} is below minimum, clamping to ${MIN_NODE_VERSION}`);
			originalNodeVersion = MIN_NODE_VERSION;
		}

		if (originalNodeVersion && isNvmAvailable()) {
			installedNodeVersion = ensureNodeVersion(originalNodeVersion);
			if (installedNodeVersion) {
				const versionNote = installedNodeVersion === originalNodeVersion ? '' : ` (requested ${originalNodeVersion})`;
				console.log(`  -> Using node version: ${installedNodeVersion}${versionNote}`);
			}
		}

		const npmVersion = getNpmVersion(installedNodeVersion);

		let publishTime = null;
		try {
			const thePackument = await packument(mani.name, { fullMetadata: true });
			if (thePackument.time && thePackument.time[mani.version]) {
				publishTime = thePackument.time[mani.version];
			}
		} catch (e) {
			console.error(`  -> Failed to fetch packument for publish time: ${/** @type {Error} */ (e).message}`);
		}

		if (!publishTime) {
			throw new Error(`Could not determine publish time for ${spec} - required for --before`);
		}

		try {
			if (!existsSync(repoCacheDir)) {
				exec(`git clone --depth 1 "https://github.com/${location}.git" "${repoCacheDir}" 2>/dev/null`);
			}

			exec(`cd "${repoCacheDir}" && git fetch --depth 1 origin "${ref}" 2>/dev/null || git fetch origin 2>/dev/null || true`);
			exec(`cd "${repoCacheDir}" && git checkout "${ref}" 2>/dev/null || git checkout FETCH_HEAD 2>/dev/null`);

			const packageDir = effectiveDirectory ? pathJoin(repoCacheDir, effectiveDirectory) : repoCacheDir;

			await rewriteWorkspaceDeps(packageDir);
			npmInstall(packageDir, {
				before: publishTime,
				nodeVersion: installedNodeVersion,
				npmVersion,
			});

			packed = npmPack(packageDir, {
				nodeVersion: installedNodeVersion,
				before: publishTime,
			});
		} catch (e) {
			console.error(`  -> Reproduce error: ${/** @type {Error} */ (e).message}`);
		}

		/** @type {ReproduceResult} */
		const result = {
			reproduceVersion: `${pkg.version}-local`,
			timestamp: new Date().toISOString(),
			os: process.platform,
			arch: process.arch,
			strategy: `npm:${npmVersion}`,
			reproduced: packed?.integrity ? mani.dist.integrity === packed.integrity : false,
			attested: !!(/** @type {{ attestations?: { url?: string } }} */ (mani.dist).attestations?.url),
			package: {
				spec,
				name: mani.name,
				version: mani.version,
				location: mani.dist.tarball,
				integrity: /** @type {string} */ (mani.dist.integrity),
				publishedAt: /** @type {string} */ (publishTime),
				publishedWith: {
					node: /** @type {string | undefined} */ (mani._nodeVersion) || null,
					npm: /** @type {string | undefined} */ (mani._npmVersion) || null,
				},
				dependencies: /** @type {Record<string, string>} */ (mani.dependencies || {}),
			},
			source: {
				integrity: packed?.integrity ?? null,
				location: /** @type {string} */ (repo.url),
				spec: source,
			},
		};

		mergedOpts.cache[spec] = result;
		await writeFile(cacheFilePath, JSON.stringify(mergedOpts.cache, null, 2));

		return result;
	} catch (e) {
		console.error(`  -> Failed: ${/** @type {Error} */ (e).message}`);
		mergedOpts.cache[spec] = false;
		return false;
	}
}
