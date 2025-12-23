/**
 * File-level comparison utility for npm package reproducibility.
 *
 * This module compares two tarballs (or directories) and returns detailed
 * file-level diff information. Designed to be upstreamed to the `reproduce` package.
 *
 * @module compare
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

/**
 * @typedef {object} FileComparison
 * @property {boolean} match - Whether the file contents match
 * @property {'match' | 'content' | 'missing-in-source' | 'missing-in-package' | 'type-mismatch'} status
 * @property {string} [packageHash] - SHA-256 hash of file in published package
 * @property {string} [sourceHash] - SHA-256 hash of file in rebuilt source
 * @property {number} [size] - File size in bytes (from package)
 */

/**
 * @typedef {object} ComparisonSummary
 * @property {number} totalFiles - Total unique files across both sources
 * @property {number} matchingFiles - Number of files that match exactly
 * @property {number} differentFiles - Number of files with different content
 * @property {number} missingInSource - Files in package but not in source
 * @property {number} missingInPackage - Files in source but not in package
 * @property {number} score - Reproducibility score from 0 to 1
 */

/**
 * @typedef {object} ComparisonResult
 * @property {Record<string, FileComparison>} files - Per-file comparison results
 * @property {ComparisonSummary} summary - Aggregated statistics
 */

/**
 * Recursively get all files in a directory.
 *
 * @param {string} dir - Directory path
 * @param {string} [base] - Base path for relative paths
 * @returns {Promise<string[]>} Array of relative file paths
 */
async function getFiles(dir, base = dir) {
	/** @type {string[]} */
	var files = [];
	var entries = await readdir(dir, { withFileTypes: true });

	for (var entry of entries) {
		var fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			var subFiles = await getFiles(fullPath, base);
			files = files.concat(subFiles);
		} else if (entry.isFile()) {
			files.push(relative(base, fullPath));
		}
	}

	return files;
}

/**
 * Calculate SHA-256 hash of a file.
 *
 * @param {string} filePath - Path to file
 * @returns {Promise<string>} Hex-encoded SHA-256 hash
 */
async function hashFile(filePath) {
	var content = await readFile(filePath);
	return createHash('sha256').update(content).digest('hex');
}

/**
 * Get file size.
 *
 * @param {string} filePath - Path to file
 * @returns {Promise<number>} File size in bytes
 */
async function getFileSize(filePath) {
	var stats = await stat(filePath);
	return stats.size;
}

/**
 * Compare two directories and return detailed file-level diff information.
 *
 * @param {string} packageDir - Path to extracted published package
 * @param {string} sourceDir - Path to rebuilt source package
 * @returns {Promise<ComparisonResult>} Detailed comparison result
 */
export async function compareDirectories(packageDir, sourceDir) {
	var [packageFiles, sourceFiles] = await Promise.all([
		getFiles(packageDir),
		getFiles(sourceDir),
	]);

	var packageSet = new Set(packageFiles);
	var sourceSet = new Set(sourceFiles);
	var allFiles = new Set([...packageFiles, ...sourceFiles]);

	/** @type {Record<string, FileComparison>} */
	var files = {};

	var matchingFiles = 0;
	var differentFiles = 0;
	var missingInSource = 0;
	var missingInPackage = 0;

	for (var file of allFiles) {
		var inPackage = packageSet.has(file);
		var inSource = sourceSet.has(file);

		if (inPackage && inSource) {
			var packagePath = join(packageDir, file);
			var sourcePath = join(sourceDir, file);

			var [packageHash, sourceHash, size] = await Promise.all([
				hashFile(packagePath),
				hashFile(sourcePath),
				getFileSize(packagePath),
			]);

			if (packageHash === sourceHash) {
				files[file] = {
					match: true,
					status: 'match',
					packageHash: packageHash,
					sourceHash: sourceHash,
					size: size,
				};
				matchingFiles += 1;
			} else {
				files[file] = {
					match: false,
					status: 'content',
					packageHash: packageHash,
					sourceHash: sourceHash,
					size: size,
				};
				differentFiles += 1;
			}
		} else if (inPackage && !inSource) {
			var pkgPath = join(packageDir, file);
			var [pkgHash, pkgSize] = await Promise.all([
				hashFile(pkgPath),
				getFileSize(pkgPath),
			]);
			files[file] = {
				match: false,
				status: 'missing-in-source',
				packageHash: pkgHash,
				size: pkgSize,
			};
			missingInSource += 1;
		} else {
			files[file] = {
				match: false,
				status: 'missing-in-package',
			};
			missingInPackage += 1;
		}
	}

	var totalFiles = allFiles.size;
	var score = totalFiles > 0 ? matchingFiles / totalFiles : 1;

	return {
		files: files,
		summary: {
			totalFiles: totalFiles,
			matchingFiles: matchingFiles,
			differentFiles: differentFiles,
			missingInSource: missingInSource,
			missingInPackage: missingInPackage,
			score: score,
		},
	};
}

/**
 * Filter comparison results to only include non-matching files.
 * Useful for reducing storage size when only failures matter.
 *
 * @param {ComparisonResult} result - Full comparison result
 * @returns {ComparisonResult} Filtered result with only non-matching files
 */
export function filterNonMatching(result) {
	/** @type {Record<string, FileComparison>} */
	var filtered = {};

	for (var file of Object.keys(result.files)) {
		if (!result.files[file].match) {
			filtered[file] = result.files[file];
		}
	}

	return {
		files: filtered,
		summary: result.summary,
	};
}
