import { execSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import pacote from 'pacote';
import { reproduce } from 'reproduce';
import { compare as semverCompare, Range } from 'semver';

import { compareDirectories, filterNonMatching } from './compare.mjs';
import COMPARISON_HASH from './comparison-hash.mjs';

const { PACKAGE: pkg, VERSIONS } = process.env;

const pkgDir = path.join(process.cwd(), 'data', 'results', /** @type {string} */ (pkg));

/** @typedef {`${number}.${number}.${number}${'' | '-${string}'}`} Version */
/** @typedef {import('reproduce').ReproduceResult} ReproduceResult */
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
	// Handle git+https://... format
	let url = location.replace(/^git\+/, '');

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

		// Fetch and checkout the specific commit
		execSync(`cd "${sourceDir}" && git fetch --depth 1 origin "${gitRef}" 2>/dev/null || git fetch origin "${gitRef}" 2>/dev/null || git fetch --unshallow origin 2>/dev/null || true`, { stdio: 'pipe' });
		execSync(`cd "${sourceDir}" && git checkout "${gitRef}"`, { stdio: 'pipe' });

		/*
		 * Install dependencies and run npm pack with node_modules/.bin in PATH
		 * This is needed because prepack scripts may use local binaries
		 * For monorepos, run in the package subdirectory
		 */
		execSync(`cd "${packageDir}" && npm install`, { stdio: 'pipe' });
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

// Fetch all versions from npm and filter by the provided semver range
const packument = await pacote.packument(/** @type {string} */ (pkg));
const allVersions = /** @type {Version[]} */ (Object.keys(packument.versions));
const range = new Range(/** @type {string} */ (VERSIONS));
const versions = allVersions.filter((v) => range.test(v));

const [
	results,
	existingData,
] = (
	await Promise.all(/** @type {const} */ ([
		Promise.all(versions.map(async (v) => reproduce(`${pkg}@${v}`))),
		/** @type {Promise<{ [k in Version]: EnhancedResult[] }>} */ (
			Promise.all(versions.map(async (v) => /** @type {const} */ ([
				v,
				/** @type {EnhancedResult[]} */ (JSON.parse(await readFile(path.join(pkgDir, v.replace(/^v?/, 'v')), 'utf8').catch(() => '[]'))),
			]))).then(Object.fromEntries)
		),
	]))
);

// Process results sequentially to avoid overwhelming the system
/** @type {Error[]} */
const errors = [];

for (const result of results) {
	if (!result) {
		continue;
	}

	// Perform file-level comparison
	let comparison;
	try {
		comparison = await performComparison(result);
	} catch (err) {
		console.error(`Comparison failed for ${result.package.name}@${result.package.version}:`, /** @type {Error} */ (err).message);
		errors.push(/** @type {Error} */ (err));
		continue;
	}

	/** @type {EnhancedResult} */
	const enhancedResult = {
		...result,
		comparisonHash: COMPARISON_HASH,
		diff: comparison,
	};

	const dataPath = path.join(pkgDir, result.package.version.replace(/^v?/, 'v'));
	const existing = existingData[/** @type {Version} */ (result.package.version)] ?? [];

	existing.push(enhancedResult);
	existing.sort((a, b) => {
		const dA = Number(new Date(a.timestamp));
		const dB = Number(new Date(b.timestamp));
		if (dA !== dB) {
			return dA - dB;
		}
		const vv = semverCompare(a.package.version, b.package.version);
		if (vv !== 0) {
			return vv;
		}

		return semverCompare(a.reproduceVersion, b.reproduceVersion);
	});

	await writeFile(dataPath, `${JSON.stringify(existing, null, '\t')}\n`);
}

if (errors.length > 0) {
	throw new Error(`${errors.length} version(s) failed comparison`);
}
