import { execSync } from 'node:child_process';

import pacote from 'pacote';
import { compare as semverCompare } from 'semver';

import normalizeGitUrl from './normalize-git-url.mjs';

/**
 * Parse source location to extract clone URL and subdirectory for monorepos.
 *
 * @param {string} location - Source location URL
 * @returns {{ cloneUrl: string, subdir: string | null }} Clone URL and optional subdirectory
 */
export function parseSourceLocation(location) {
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
 * Check if a git repo URL is reachable.
 *
 * @param {string} url - Git URL to check
 * @returns {boolean} True if reachable
 */
function isRepoReachable(url) {
	try {
		execSync(`git ls-remote "${url}" HEAD`, { stdio: 'pipe', timeout: 30000 });
		return true;
	} catch {
		return false;
	}
}

/**
 * Find a working repository URL by checking other versions of the same package.
 * Falls back to other versions if the current version's repo URL is broken.
 *
 * @param {string} pkgName - Package name
 * @param {string} currentRepoUrl - Current (possibly broken) repo URL
 * @returns {Promise<string | null>} Working repo URL or null if none found
 */
async function findWorkingRepoUrl(pkgName, currentRepoUrl) {
	try {
		const packument = await pacote.packument(pkgName);
		const versions = Object.keys(packument.versions || {});

		// Collect unique repo URLs from all versions, preferring newer versions
		/** @type {Set<string>} */
		const seenUrls = new Set();
		/** @type {string[]} */
		const repoUrls = [];

		// Sort versions newest first
		versions.sort((a, b) => semverCompare(b, a));

		for (const ver of versions) {
			const manifest = /** @type {{ repository?: string | { url?: string } }} */ (packument.versions[ver]);
			const repo = manifest?.repository;
			const repoUrl = typeof repo === 'string' ? repo : repo?.url;
			if (repoUrl) {
				const normalized = normalizeGitUrl(repoUrl);
				if (!seenUrls.has(normalized) && normalized !== currentRepoUrl) {
					seenUrls.add(normalized);
					repoUrls.push(normalized);
				}
			}
		}

		// Also check the top-level packument repository
		const topRepo = /** @type {{ repository?: string | { url?: string } }} */ (packument).repository;
		const topRepoUrl = typeof topRepo === 'string' ? topRepo : topRepo?.url;
		if (topRepoUrl) {
			const normalized = normalizeGitUrl(topRepoUrl);
			if (!seenUrls.has(normalized) && normalized !== currentRepoUrl) {
				repoUrls.unshift(normalized); // Prefer top-level
			}
		}

		// Try each URL until we find one that works
		for (const url of repoUrls) {
			const { cloneUrl } = parseSourceLocation(url);
			console.log(`  -> Trying fallback repo: ${cloneUrl}`);
			if (isRepoReachable(cloneUrl)) {
				console.log(`  -> Found working repo: ${cloneUrl}`);
				return cloneUrl;
			}
		}

		return null;
	} catch (err) {
		console.error(`  -> Failed to find fallback repo: ${/** @type {Error} */ (err).message}`);
		return null;
	}
}

/**
 * Try to clone a git repository, with fallback to alternative URLs if the primary fails.
 *
 * @param {string} primaryUrl - Primary clone URL to try first
 * @param {string} destDir - Destination directory for clone
 * @param {string} pkgName - Package name (for fallback lookup)
 * @returns {Promise<void>}
 * @throws {Error} If all clone attempts fail
 */
export async function cloneWithFallback(primaryUrl, destDir, pkgName) {
	// First try the primary URL
	try {
		execSync(`git clone --depth 1 "${primaryUrl}" "${destDir}" 2>/dev/null || git clone "${primaryUrl}" "${destDir}"`, { stdio: 'pipe' });
		return;
	} catch {
		console.log(`  -> Primary repo URL failed: ${primaryUrl}`);
	}

	// Try to find an alternative URL from other versions
	const fallbackUrl = await findWorkingRepoUrl(pkgName, primaryUrl);
	if (fallbackUrl) {
		try {
			execSync(`git clone --depth 1 "${fallbackUrl}" "${destDir}" 2>/dev/null || git clone "${fallbackUrl}" "${destDir}"`, { stdio: 'pipe' });
			console.log(`  -> Cloned from fallback repo: ${fallbackUrl}`);
			return;
		} catch (err) {
			throw new Error(`Fallback repo also failed: ${/** @type {Error} */ (err).message}`, { cause: err });
		}
	}

	throw new Error(`No reachable repository found for ${pkgName}`);
}
