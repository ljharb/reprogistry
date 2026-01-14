import { execSync } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { compare as semverCompare } from 'semver';

import { compareDirectories, filterNonMatching } from './compare.mjs';

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
	const pkgPath = path.join(packageDir, 'package.json');
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

/**
 * Remove a dependency from package.json (checks all dep types).
 *
 * @param {string} packageDir - Directory containing package.json
 * @param {string} depName - Name of the dependency to remove
 */
async function removeDep(packageDir, depName) {
	const pkgPath = path.join(packageDir, 'package.json');
	const pkgJson = JSON.parse(await readFile(pkgPath, 'utf8'));

	for (const depType of depTypes) {
		if (pkgJson[depType] && pkgJson[depType][depName]) {
			delete pkgJson[depType][depName];
		}
	}

	await writeFile(pkgPath, JSON.stringify(pkgJson, null, 2));
}

/**
 * Install dependencies with retry logic for missing packages.
 * If a dep fails with ETARGET (unpublished), remove it and retry.
 *
 * @param {string} packageDir - Directory containing package.json
 * @param {number} maxRetries - Maximum number of retries
 */
async function installWithRetry(packageDir, maxRetries = 5) {
	const installCmd = `cd "${packageDir}" && npm install --ignore-scripts --legacy-peer-deps --force`;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			execSync(installCmd, { stdio: 'pipe' });
			return; // Success
		} catch (err) {
			const stderr = /** @type {Error & { stderr?: Buffer }} */ (err).stderr?.toString() || '';
			const stdout = /** @type {Error & { stdout?: Buffer }} */ (err).stdout?.toString() || '';
			const output = stderr + stdout;

			// Check for ETARGET/notarget error with a specific package
			const match = output.match(/No matching version found for (?<pkgSpec>[^\s@]+@[^\s]+)/);
			if (match?.groups && attempt < maxRetries) {
				const failedDep = match.groups.pkgSpec.split('@')[0];
				console.log(`  -> Removing unpublished dep: ${failedDep}`);
				await removeDep(packageDir, failedDep); // eslint-disable-line no-await-in-loop
				continue; // eslint-disable-line no-continue, no-restricted-syntax
			}

			throw err; // Re-throw if not ETARGET or max retries reached
		}
	}
}

import COMPARISON_HASH from './comparison-hash.mjs';
import reproduce from './reproduce.mjs';
import { cloneWithFallback, parseSourceLocation } from './repo-fallback.mjs';

/**
 * @typedef {{ name: string, version: string }} DepInfo
 */

/**
 * Parse production deps from lockfile v2/v3 packages object.
 *
 * @param {Record<string, unknown>} packages - The packages object from lockfile
 * @returns {DepInfo[]} Array of production dependencies
 */
function parseLockV2Deps(packages) {
	/** @type {DepInfo[]} */
	const deps = [];
	for (const [pkgPath, pkgInfo] of Object.entries(packages)) {
		if (!pkgPath) {
			continue; // eslint-disable-line no-continue, no-restricted-syntax
		}
		if (/** @type {{ dev?: boolean }} */ (pkgInfo).dev) {
			continue; // eslint-disable-line no-continue, no-restricted-syntax
		}
		const match = pkgPath.match(/node_modules\/(?<pkgName>(?:@[^/]+\/)?[^/]+)$/);
		const { pkgName } = match?.groups || {};
		const ver = /** @type {{ version?: string }} */ (pkgInfo).version;
		if (pkgName && ver) {
			deps.push({ name: pkgName, version: ver });
		}
	}
	return deps;
}

/**
 * Parse production deps from lockfile v1 dependencies object.
 *
 * @param {Record<string, { version?: string, dev?: boolean, dependencies?: Record<string, unknown> }>} deps
 * @param {DepInfo[]} result - Accumulator array
 */
function parseLockV1Deps(deps, result) {
	for (const [name, info] of Object.entries(deps)) {
		if (!info.dev && info.version) {
			result.push({ name, version: info.version });
		}
		if (info.dependencies) {
			parseLockV1Deps(/** @type {Record<string, { version?: string, dev?: boolean, dependencies?: Record<string, unknown> }>} */ (info.dependencies), result);
		}
	}
}

/**
 * Extract production dependencies from package-lock.json.
 *
 * @param {string} dir - Directory containing package-lock.json
 * @returns {Promise<DepInfo[]>} Array of production dependencies
 */
async function getProdDeps(dir) {
	const lockPath = path.join(dir, 'package-lock.json');
	if (!existsSync(lockPath)) {
		console.log('  -> No package-lock.json found, skipping dependency extraction');
		return [];
	}

	try {
		const lockfile = JSON.parse(await readFile(lockPath, 'utf8'));
		/** @type {DepInfo[]} */
		let prodDeps = [];

		if (lockfile.packages && typeof lockfile.packages === 'object') {
			prodDeps = parseLockV2Deps(lockfile.packages);
		} else if (lockfile.dependencies && typeof lockfile.dependencies === 'object') {
			parseLockV1Deps(lockfile.dependencies, prodDeps);
		}

		// Dedupe by name+version
		const seen = new Set();
		const uniqueDeps = prodDeps.filter((dep) => {
			const key = `${dep.name}@${dep.version}`;
			if (seen.has(key)) {
				return false;
			}
			seen.add(key);
			return true;
		});

		console.log(`  -> Extracted ${uniqueDeps.length} production dependencies`);
		return uniqueDeps;
	} catch (err) {
		console.error(`  -> Failed to extract deps: ${/** @type {Error} */ (err).message}`);
		return [];
	}
}

/**
 * Save production dependencies to file for queueing.
 *
 * @param {DepInfo[]} deps - Dependencies to save
 * @param {string} ver - Package version (for file naming)
 */
async function saveDepsForQueue(deps, ver) {
	if (deps.length === 0) {
		return;
	}
	const safeVersion = ver.replace(/\+/g, '__');
	const depsDir = '/tmp/deps';
	await mkdir(depsDir, { recursive: true });
	const depsPath = path.join(depsDir, `${safeVersion}.json`);
	await writeFile(depsPath, JSON.stringify(deps));
	console.log(`  -> Wrote ${deps.length} deps to ${depsPath}`);
}

const { PACKAGE: pkg, VERSION: version } = process.env;

if (!pkg || !version) {
	console.error('PACKAGE and VERSION environment variables are required');
	process.exit(1);
}

const pkgDir = path.join(process.cwd(), 'data', 'results', /** @type {string} */ (pkg));

/** @typedef {`${number}.${number}.${number}${'' | '-${string}'}`} Version */
/** @typedef {{ spec: string, name: string, version: string, location: string, integrity: string, publishedAt?: string | null, publishedWith?: { node?: string | null, npm?: string | null }, dependencies?: Record<string, string> }} PackageInfo */
/** @typedef {{ spec: string, location: string, integrity?: string | null }} SourceInfo */
/** @typedef {{ reproduceVersion: string, timestamp: string, os: string, arch: string, strategy: string, reproduced: boolean, attested: boolean, package: PackageInfo, source: SourceInfo }} ReproduceResult */
/** @typedef {import('./compare.mjs').ComparisonResult} ComparisonResult */

/**
 * @typedef {ReproduceResult & { comparisonHash?: string, diff?: { files: Record<string, import('./compare.mjs').FileComparison>, summary: import('./compare.mjs').ComparisonSummary }, prodDependencies?: DepInfo[] }} EnhancedResult
 */

/**
 * @typedef {{ comparison: ComparisonResult, prodDependencies: DepInfo[] }} ComparisonWithDeps
 */

/**
 * Download a file from a URL to a local path.
 *
 * @param {string} url - URL to download
 * @param {string} destPath - Destination file path
 */
async function downloadFile(url, destPath) {
	const response = await fetch(url);
	if (!response.ok || !response.body) {
		throw new Error(`Failed to download ${url}: ${response.status}`);
	}
	const fileStream = createWriteStream(destPath);
	// @ts-ignore - response.body is a ReadableStream
	await pipeline(response.body, fileStream);
}

/**
 * Extract a tarball to a directory.
 * Uses --no-same-permissions to avoid EACCES errors on old packages with restrictive permissions.
 *
 * @param {string} tarballPath - Path to tarball
 * @param {string} destDir - Destination directory
 */
async function extractTarball(tarballPath, destDir) {
	await mkdir(destDir, { recursive: true });
	execSync(`tar -xzf "${tarballPath}" -C "${destDir}" --strip-components=1 --no-same-permissions`, { stdio: 'pipe' });
}

/**
 * Perform file-level comparison between published and rebuilt packages.
 * Also extracts production dependencies from the generated lockfile.
 *
 * @param {ReproduceResult} result - Reproduce result
 * @param {string} ver - Package version (for deps file naming)
 * @returns {Promise<ComparisonWithDeps>} Comparison result with dependencies
 * @throws {Error} If comparison fails
 */
async function performComparison(result, ver) {
	const tempDir = path.join(tmpdir(), `reproduce-compare-${Date.now()}`);
	const publishedDir = path.join(tempDir, 'published');
	const rebuiltDir = path.join(tempDir, 'rebuilt');
	const publishedTarball = path.join(tempDir, 'published.tgz');
	const sourceDir = path.join(tempDir, 'source');

	try {
		await mkdir(tempDir, { recursive: true });

		// Download published tarball from npm
		await downloadFile(result.package.location, publishedTarball);

		// Extract the git ref and repo URL from the source spec (e.g., "github:ljharb/qs#abc123")
		const sourceSpec = result.source.spec;
		const refMatch = sourceSpec.match(/#(?<ref>[^:]+)(?::path:.*)?$/);
		const gitRef = refMatch?.groups?.ref ?? 'HEAD';

		// Parse source location to get clone URL and subdirectory
		const { cloneUrl, subdir } = parseSourceLocation(result.source.location);
		const packageDir = subdir ? path.join(sourceDir, subdir) : sourceDir;

		// Clone the repo with fallback to alternative URLs if primary fails
		await cloneWithFallback(cloneUrl, sourceDir, result.package.name);

		/*
		 * Fetch and checkout the specific commit or tag
		 * For tags, we need to fetch them explicitly since shallow clones don't include tags
		 */
		execSync(`cd "${sourceDir}" && git fetch --depth 1 origin tag "${gitRef}" 2>/dev/null || git fetch --depth 1 origin "${gitRef}" 2>/dev/null || git fetch origin "${gitRef}" 2>/dev/null || git fetch --tags --unshallow origin 2>/dev/null || true`, { stdio: 'pipe' });
		execSync(`cd "${sourceDir}" && git checkout "${gitRef}" 2>/dev/null || git checkout "tags/${gitRef}" 2>/dev/null || git checkout FETCH_HEAD`, { stdio: 'pipe' });

		/*
		 * Install dependencies and run npm pack with node_modules/.bin in PATH
		 * This is needed because prepack scripts may use local binaries
		 * For monorepos, run in the package subdirectory
		 * Use --ignore-scripts to avoid postinstall failures from old native deps
		 * Use --force to ignore platform checks (e.g., darwin-only packages on linux)
		 */
		await rewriteWorkspaceDeps(packageDir);
		await installWithRetry(packageDir);

		// Extract production dependencies from the generated lockfile
		const prodDependencies = await getProdDeps(packageDir);

		// Save deps immediately so they're captured even if comparison fails later
		await saveDepsForQueue(prodDependencies, ver);

		const packOutput = execSync(
			`cd "${packageDir}" && npm pack --pack-destination "${tempDir}"`,
			{ env: { ...process.env, PATH: `${packageDir}/node_modules/.bin:${process.env.PATH}` }, stdio: 'pipe' },
		);
		const tarballName = packOutput.toString().trim().split('\n').pop();
		if (!tarballName) {
			throw new Error('npm pack produced no output');
		}
		const rebuiltTarballPath = path.join(tempDir, tarballName);

		// Extract both tarballs
		await extractTarball(publishedTarball, publishedDir);
		await extractTarball(rebuiltTarballPath, rebuiltDir);

		// Compare directories
		const comparison = await compareDirectories(publishedDir, rebuiltDir);

		// Only store non-matching files to save space
		return {
			comparison: filterNonMatching(comparison),
			prodDependencies,
		};
	} finally {
		// Cleanup temp directory
		await rm(tempDir, { force: true, recursive: true }).catch(() => {});
	}
}

console.log(`Processing ${pkg}@${version}...`);

await mkdir(pkgDir, { recursive: true });

// Load existing data
const dataPath = path.join(pkgDir, version.replace(/^v?/, 'v'));
const existing = /** @type {EnhancedResult[]} */ (
	JSON.parse(await readFile(dataPath, 'utf8').catch(() => '[]'))
);

// Run reproduce
console.log(`Reproducing ${pkg}@${version}...`);
let result;
try {
	result = await reproduce(`${pkg}@${version}`);
	if (!result) {
		console.log('  -> No source tracking available');
		process.exit(0);
	}
} catch (err) {
	console.error(`  -> Reproduce failed: ${/** @type {Error} */ (err).message}`);
	process.exit(1);
}

// Perform comparison
console.log(`Comparing ${pkg}@${version}...`);
const reproduceResult = /** @type {ReproduceResult} */ (result);
/** @type {ComparisonWithDeps | null} */
let comparisonWithDeps = null;
try {
	comparisonWithDeps = await performComparison(reproduceResult, version);
	console.log(`  -> Score: ${Math.round((comparisonWithDeps.comparison.summary?.score ?? 0) * 100)}%`);
	if (comparisonWithDeps.prodDependencies.length > 0) {
		console.log(`  -> Found ${comparisonWithDeps.prodDependencies.length} production dependencies`);
	}
} catch (err) {
	console.error(`  -> Comparison failed: ${/** @type {Error} */ (err).message}`);
	process.exit(1);
}

/** @type {EnhancedResult} */
const enhancedResult = {
	...reproduceResult,
	comparisonHash: COMPARISON_HASH,
	diff: comparisonWithDeps.comparison,
	prodDependencies: comparisonWithDeps.prodDependencies,
};

existing.push(enhancedResult);

// Dedupe: keep only the latest result per reproduceVersion, preferring those with diff data
/** @type {Map<string, EnhancedResult>} */
const byReproduceVersion = new Map();
for (const r of existing) {
	const key = r.reproduceVersion;
	const prev = byReproduceVersion.get(key);
	if (prev) {
		// Prefer result with diff data, then latest timestamp
		const prevHasDiff = prev.diff && prev.diff.summary;
		const currHasDiff = r.diff && r.diff.summary;
		if (currHasDiff && !prevHasDiff) {
			byReproduceVersion.set(key, r);
		} else if (currHasDiff === prevHasDiff) {
			// Both have or both lack diff - keep latest
			if (new Date(r.timestamp) > new Date(prev.timestamp)) {
				byReproduceVersion.set(key, r);
			}
		}
		// else: prev has diff, curr doesn't - keep prev
	} else {
		byReproduceVersion.set(key, r);
	}
}

const deduped = [...byReproduceVersion.values()];
deduped.sort((a, b) => {
	const dA = Number(new Date(a.timestamp));
	const dB = Number(new Date(b.timestamp));
	if (dA !== dB) {
		return dA - dB;
	}
	return semverCompare(a.reproduceVersion, b.reproduceVersion);
});

await writeFile(dataPath, `${JSON.stringify(deduped, null, '\t')}\n`);
console.log(`  -> Saved to ${dataPath}`);
