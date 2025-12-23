import { execSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { reproduce } from 'reproduce';
import { compare as semverCompare, Range } from 'semver';

import { compareDirectories, filterNonMatching } from './compare.mjs';

const { PACKAGE: pkg, VERSIONS } = process.env;

const pkgDir = path.join(process.cwd(), 'data', 'results', /** @type {string} */ (pkg));

/** @typedef {`${number}.${number}.${number}${'' | '-${string}'}`} Version */
/** @typedef {import('reproduce').ReproduceResult} ReproduceResult */
/** @typedef {import('./compare.mjs').ComparisonResult} ComparisonResult */

/**
 * @typedef {ReproduceResult & { diff?: { files: Record<string, import('./compare.mjs').FileComparison>, summary: import('./compare.mjs').ComparisonSummary } }} EnhancedResult
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
 * Get the rebuilt tarball path from reproduce's cache.
 *
 * @param {string} packageName - Package name
 * @param {string} version - Package version
 * @returns {string} Path to rebuilt tarball
 */
function getRebuiltTarballPath(packageName, version) {
	const cacheDir = process.platform === 'darwin'
		? path.join(process.env.HOME || '', 'Library', 'Caches', 'reproduce')
		: path.join(process.env.XDG_CACHE_HOME || path.join(process.env.HOME || '', '.cache'), 'reproduce');

	const safeName = packageName.replace(/^@/, '').replace(/\//, '-');
	return path.join(cacheDir, packageName, `${safeName}-${version}.tgz`);
}

/**
 * Perform file-level comparison between published and rebuilt packages.
 *
 * @param {ReproduceResult} result - Reproduce result
 * @returns {Promise<ComparisonResult | null>} Comparison result or null if comparison failed
 */
async function performComparison(result) {
	const tempDir = path.join(tmpdir(), `reproduce-compare-${Date.now()}`);
	const publishedDir = path.join(tempDir, 'published');
	const rebuiltDir = path.join(tempDir, 'rebuilt');
	const publishedTarball = path.join(tempDir, 'published.tgz');

	try {
		await mkdir(tempDir, { recursive: true });

		// Download published tarball from npm
		await downloadFile(result.package.location, publishedTarball);

		// Find rebuilt tarball in reproduce cache
		const rebuiltTarball = getRebuiltTarballPath(result.package.name, result.package.version);

		// Try to pack from the cloned source if tarball doesn't exist
		const cacheDir = process.platform === 'darwin'
			? path.join(process.env.HOME || '', 'Library', 'Caches', 'reproduce')
			: path.join(process.env.XDG_CACHE_HOME || path.join(process.env.HOME || '', '.cache'), 'reproduce');
		const sourceDir = path.join(cacheDir, result.package.name);

		let rebuiltTarballPath = rebuiltTarball;
		try {
			// Pack the source to get a tarball
			execSync(`cd "${sourceDir}" && npm pack --pack-destination "${tempDir}" >/dev/null 2>&1`, { stdio: 'pipe' });
			const safeName = result.package.name.replace(/^@/, '').replace(/\//, '-');
			rebuiltTarballPath = path.join(tempDir, `${safeName}-${result.package.version}.tgz`);
		} catch {
			// Fall back to using pre-existing tarball if pack fails
		}

		// Extract both tarballs
		await extractTarball(publishedTarball, publishedDir);
		await extractTarball(rebuiltTarballPath, rebuiltDir);

		// Compare directories
		const comparison = await compareDirectories(publishedDir, rebuiltDir);

		// Only store non-matching files to save space
		return filterNonMatching(comparison);
	} catch (err) {
		console.error(`Comparison failed for ${result.package.name}@${result.package.version}:`, /** @type {Error} */ (err).message);
		return null;
	} finally {
		// Cleanup temp directory
		await rm(tempDir, { recursive: true, force: true }).catch(() => {});
	}
}

const versions = /** @type {Version[]} */ (
	new Range(/** @type {string} */ (VERSIONS)).set.flat(1).map((x) => x.value)
);

const [
	results,
	existingData,
] = (
	await Promise.all(/** @type {const} */ ([
		Promise.all(versions.map(async (v) => reproduce(`${pkg}@${v}`))),
		/** @type {Promise<{ [k in Version]: EnhancedResult[] }>} */ (
			Promise.all(versions.map(async (v) => /** @type {const} */ ([
				v,
				/** @type {EnhancedResult[]} */ (JSON.parse(await readFile(path.join(pkgDir, v), 'utf8').catch(() => '[]'))),
			]))).then(Object.fromEntries)
		),
	]))
);

// Process results sequentially to avoid overwhelming the system
for (const result of results) {
	if (!result) {
		continue;
	}

	/** @type {EnhancedResult} */
	const enhancedResult = { ...result };

	// Perform file-level comparison
	const comparison = await performComparison(result);
	if (comparison) {
		enhancedResult.diff = comparison;
	}

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
