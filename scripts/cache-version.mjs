import { execSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { compare as semverCompare } from 'semver';

import { compareDirectories, filterNonMatching } from './compare.mjs';

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

	for (const depType of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
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
import normalizeGitUrl from './normalize-git-url.mjs';
import COMPARISON_HASH from './comparison-hash.mjs';
import reproduce from './reproduce.js';

const { PACKAGE: pkg, VERSION: version } = process.env;

if (!pkg || !version) {
	console.error('PACKAGE and VERSION environment variables are required');
	process.exit(1);
}

const pkgDir = path.join(process.cwd(), 'data', 'results', /** @type {string} */ (pkg));

/** @typedef {`${number}.${number}.${number}${'' | '-${string}'}`} Version */
/** @typedef {{ reproduceVersion: string, timestamp: string, os: string, arch: string, strategy: string, reproduced: boolean, attested: boolean, package: object, source: object }} ReproduceResult */
/** @typedef {import('./compare.mjs').ComparisonResult} ComparisonResult */

/**
 * @typedef {ReproduceResult & { comparisonHash?: string, diff?: { files: Record<string, import('./compare.mjs').FileComparison>, summary: import('./compare.mjs').ComparisonSummary } }} EnhancedResult
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
 *
 * @param {string} tarballPath - Path to tarball
 * @param {string} destDir - Destination directory
 */
async function extractTarball(tarballPath, destDir) {
	await mkdir(destDir, { recursive: true });
	execSync(`tar -xzf "${tarballPath}" -C "${destDir}" --strip-components=1`, { stdio: 'pipe' });
}

/**
 * Parse source location to extract clone URL and subdirectory for monorepos.
 *
 * @param {string} location - Source location URL
 * @returns {{ cloneUrl: string, subdir: string | null }} Clone URL and optional subdirectory
 */
function parseSourceLocation(location) {
	// Handle git+https://..., git://, and ssh:// formats
	let url = normalizeGitUrl(location);

	// Handle GitHub tree URLs (monorepos): https://github.com/org/repo/tree/branch/path/to/package
	const treeMatch = url.match(/^(?<base>https:\/\/github\.com\/[^/]+\/[^/]+)\/tree\/[^/]+\/(?<subdir>.+)$/);
	if (treeMatch?.groups) {
		return {
			cloneUrl: `${treeMatch.groups.base}.git`,
			subdir: treeMatch.groups.subdir,
		};
	}

	// Handle GitHub blob URLs (shouldn't happen but just in case)
	const blobMatch = url.match(/^(?<base>https:\/\/github\.com\/[^/]+\/[^/]+)\/blob\//);
	if (blobMatch?.groups) {
		return {
			cloneUrl: `${blobMatch.groups.base}.git`,
			subdir: null,
		};
	}

	// Regular git URL - ensure it ends with .git
	if (!url.endsWith('.git') && url.includes('github.com')) {
		url = `${url}.git`;
	}

	return { cloneUrl: url, subdir: null };
}

/**
 * Perform file-level comparison between published and rebuilt packages.
 *
 * @param {ReproduceResult} result - Reproduce result
 * @returns {Promise<ComparisonResult>} Comparison result
 * @throws {Error} If comparison fails
 */
async function performComparison(result) {
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

		// Clone the repo (shallow clone of the specific commit)
		execSync(`git clone --depth 1 "${cloneUrl}" "${sourceDir}" 2>/dev/null || git clone "${cloneUrl}" "${sourceDir}"`, { stdio: 'pipe' });

		// Fetch and checkout the specific commit or tag
		// For tags, we need to fetch them explicitly since shallow clones don't include tags
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
		execSync(`cd "${packageDir}" && npm install --ignore-scripts --legacy-peer-deps --force`, { stdio: 'pipe' });
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
		return filterNonMatching(comparison);
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
		console.log(`  -> No source tracking available`);
		process.exit(0);
	}
} catch (err) {
	console.error(`  -> Reproduce failed: ${/** @type {Error} */ (err).message}`);
	process.exit(1);
}

// Perform comparison
console.log(`Comparing ${pkg}@${version}...`);
let comparison;
try {
	comparison = await performComparison(result);
	console.log(`  -> Score: ${Math.round((comparison.summary?.score ?? 0) * 100)}%`);
} catch (err) {
	console.error(`  -> Comparison failed: ${/** @type {Error} */ (err).message}`);
	process.exit(1);
}

/** @type {EnhancedResult} */
const enhancedResult = {
	...result,
	comparisonHash: COMPARISON_HASH,
	diff: comparison,
};

existing.push(enhancedResult);

// Dedupe: keep only the latest result per reproduceVersion, preferring those with diff data
/** @type {Map<string, EnhancedResult>} */
const byReproduceVersion = new Map();
for (const r of existing) {
	const key = r.reproduceVersion;
	const prev = byReproduceVersion.get(key);
	if (!prev) {
		byReproduceVersion.set(key, r);
	} else {
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
