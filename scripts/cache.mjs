import { execSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

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
	const sourceDir = path.join(tempDir, 'source');

	try {
		await mkdir(tempDir, { recursive: true });

		// Download published tarball from npm
		await downloadFile(result.package.location, publishedTarball);

		// Extract the git ref and repo URL from the source spec (e.g., "github:ljharb/qs#abc123")
		const sourceSpec = result.source.spec;
		const refMatch = sourceSpec.match(/#(?<ref>[^:]+)(?::path:.*)?$/);
		const gitRef = refMatch?.groups?.ref ?? 'HEAD';

		// Convert source location to clone URL
		const repoUrl = result.source.location.replace(/^git\+/, '');

		// Clone and checkout the correct commit
		let rebuiltTarballPath;
		try {
			// Clone the repo (shallow clone of the specific commit)
			execSync(`git clone --depth 1 "${repoUrl}" "${sourceDir}" 2>/dev/null || git clone "${repoUrl}" "${sourceDir}"`, { stdio: 'pipe' });

			// Fetch and checkout the specific commit
			execSync(`cd "${sourceDir}" && git fetch --depth 1 origin "${gitRef}" 2>/dev/null || git fetch origin "${gitRef}" 2>/dev/null || git fetch --unshallow origin 2>/dev/null || true`, { stdio: 'pipe' });
			execSync(`cd "${sourceDir}" && git checkout "${gitRef}"`, { stdio: 'pipe' });

			/*
			 * Install dependencies and run npm pack with node_modules/.bin in PATH
			 * This is needed because prepack scripts may use local binaries
			 */
			execSync(`cd "${sourceDir}" && npm install`, { stdio: 'pipe' });
			const packOutput = execSync(
				`cd "${sourceDir}" && npm pack --pack-destination "${tempDir}"`,
				{ env: { ...process.env, PATH: `${sourceDir}/node_modules/.bin:${process.env.PATH}` }, stdio: 'pipe' },
			);
			const tarballName = packOutput.toString().trim().split('\n').pop();
			rebuiltTarballPath = path.join(tempDir, tarballName || '');

			if (!tarballName) {
				throw new Error('npm pack produced no output');
			}
		} catch (packErr) {
			console.error(`Pack failed for ${result.package.name}@${result.package.version}:`, /** @type {Error} */ (packErr).message);
			return null;
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
		await rm(tempDir, { force: true, recursive: true }).catch(() => {});
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
				/** @type {EnhancedResult[]} */ (JSON.parse(await readFile(path.join(pkgDir, v.replace(/^v?/, 'v')), 'utf8').catch(() => '[]'))),
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
	const enhancedResult = { ...result, comparisonHash: COMPARISON_HASH };

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
