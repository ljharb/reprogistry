#!/usr/bin/env node

import { execSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const OUTPUT_DIR = process.argv[2] || 'precompute-output/packages';

// Ensure output directory exists
mkdirSync(OUTPUT_DIR, { recursive: true });

// Get list of packages from data branch
const packagesRaw = execSync('git show origin/data:packages.txt', { encoding: 'utf8' });
const packageList = packagesRaw.trim().split('\n').filter(Boolean);

console.log(`Processing ${packageList.length} packages...`);

/**
 * @param {string} safePkg
 * @param {string} vDir
 */
const processVersion = function (safePkg, vDir) {
	// vDir is like "v1.0.0"
	const version = vDir.slice(1); // Remove 'v' prefix

	try {
		const resultRaw = execSync(`git show origin/data:results/${safePkg}/${vDir}`, { encoding: 'utf8' });
		const results = JSON.parse(resultRaw);
		const latest = results[0];

		if (!latest) {
			return null;
		}

		// Get score from diff summary
		const score = latest.diff && latest.diff.summary ? latest.diff.summary.score : null;

		return {
			reproduced: latest.reproduced,
			score,
			timestamp: latest.timestamp,
			version,
		};
	} catch {
		// Skip versions that can't be parsed
		return null;
	}
};

/** @param {string} pkg */
const processPackage = function (pkg) {
	try {
		// Get list of versions for this package
		const safePkg = pkg.startsWith('@') ? pkg : pkg;
		const versionsRaw = execSync(`git ls-tree origin/data:results/${safePkg} --name-only 2>/dev/null || true`, { encoding: 'utf8' });
		const versionDirs = versionsRaw.trim().split('\n').filter(Boolean);

		if (versionDirs.length === 0) {
			return;
		}

		const versions = /** @type {{ reproduced: boolean, score: number | null, timestamp: string, version: string }[]} */ (
			versionDirs
				.map((vDir) => processVersion(safePkg, vDir))
				.filter(Boolean)
		);

		if (versions.length === 0) {
			return;
		}

		// Sort by version (semver descending would be better, but simple string sort for now)
		versions.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));

		const output = {
			name: pkg,
			versions,
		};

		// Write package file
		const safeFilename = pkg.replace('/', '__');
		const outputPath = join(OUTPUT_DIR, `${safeFilename}.json`);
		writeFileSync(outputPath, JSON.stringify(output));

		console.log(`  ${pkg}: ${versions.length} versions`);
	} catch (e) {
		const err = /** @type {Error} */ (e);
		console.error(`  Error processing ${pkg}:`, err.message);
	}
};

packageList.forEach(processPackage);

console.log('Done.');
