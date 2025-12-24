/**
 * File-level comparison utility for npm package reproducibility.
 *
 * This module compares two tarballs (or directories) and returns detailed
 * file-level diff information. Designed to be upstreamed to the `reproduce` package.
 *
 * @module compare
 */

import { execSync } from 'node:child_process';
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
 * @property {string} [diff] - Unified diff for text files, or description for binary
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
	let files = [];
	const entries = await readdir(dir, { withFileTypes: true });

	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			const subFiles = await getFiles(fullPath, base);
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
	const content = await readFile(filePath);
	return createHash('sha256').update(content).digest('hex');
}

/**
 * Get file size.
 *
 * @param {string} filePath - Path to file
 * @returns {Promise<number>} File size in bytes
 */
async function getFileSize(filePath) {
	const stats = await stat(filePath);
	return stats.size;
}

/**
 * Check if file content appears to be binary.
 *
 * @param {Buffer} content - File content
 * @returns {boolean} True if file appears to be binary
 */
function isBinary(content) {
	// Check for null bytes in first 8KB (common binary indicator)
	const sample = content.subarray(0, 8192);
	for (let i = 0; i < sample.length; i++) {
		if (sample[i] === 0) {
			return true;
		}
	}
	return false;
}

/**
 * Generate a unified diff between two files.
 *
 * @param {string} file1 - Path to first file
 * @param {string} file2 - Path to second file
 * @param {string} label1 - Label for first file
 * @param {string} label2 - Label for second file
 * @returns {Promise<string>} Unified diff output or description
 */
async function generateDiff(file1, file2, label1, label2) {
	const [content1, content2] = await Promise.all([
		readFile(file1),
		readFile(file2),
	]);

	// Check if either file is binary
	if (isBinary(content1) || isBinary(content2)) {
		return '[binary files differ]';
	}

	try {
		// Use diff command for unified diff, limit to 50 lines of context
		const diffOutput = execSync(
			`diff -u --label "${label1}" --label "${label2}" "${file1}" "${file2}" | head -100`,
			{
				encoding: 'utf8', stdio: [
					'pipe', 'pipe', 'pipe',
				],
			},
		);
		return diffOutput || '[files are identical]';
	} catch (err) {
		// diff returns exit code 1 when files differ, which throws
		if (err && typeof err === 'object' && 'stdout' in err) {
			const output = /** @type {{ stdout: string }} */ (err).stdout;
			if (output) {
				return output;
			}
		}
		return '[diff failed]';
	}
}

/**
 * Compare two directories and return detailed file-level diff information.
 *
 * @param {string} packageDir - Path to extracted published package
 * @param {string} sourceDir - Path to rebuilt source package
 * @returns {Promise<ComparisonResult>} Detailed comparison result
 */
export async function compareDirectories(packageDir, sourceDir) {
	const [packageFiles, sourceFiles] = await Promise.all([
		getFiles(packageDir),
		getFiles(sourceDir),
	]);

	const packageSet = new Set(packageFiles);
	const sourceSet = new Set(sourceFiles);
	const allFiles = new Set([...packageFiles, ...sourceFiles]);

	/** @type {Record<string, FileComparison>} */
	const files = {};

	let matchingFiles = 0;
	let differentFiles = 0;
	let missingInSource = 0;
	let missingInPackage = 0;

	for (const file of allFiles) {
		const inPackage = packageSet.has(file);
		const inSource = sourceSet.has(file);

		if (inPackage && inSource) {
			const packagePath = join(packageDir, file);
			const sourcePath = join(sourceDir, file);

			const [
				packageHash, sourceHash, size,
			] = await Promise.all([
				hashFile(packagePath),
				hashFile(sourcePath),
				getFileSize(packagePath),
			]);

			if (packageHash === sourceHash) {
				files[file] = {
					match: true,
					packageHash,
					size,
					sourceHash,
					status: 'match',
				};
				matchingFiles += 1;
			} else {
				const diffContent = await generateDiff(
					packagePath,
					sourcePath,
					`published/${file}`,
					`rebuilt/${file}`,
				);
				files[file] = {
					diff: diffContent,
					match: false,
					packageHash,
					size,
					sourceHash,
					status: 'content',
				};
				differentFiles += 1;
			}
		} else if (inPackage && !inSource) {
			const pkgPath = join(packageDir, file);
			const [pkgHash, pkgSize] = await Promise.all([
				hashFile(pkgPath),
				getFileSize(pkgPath),
			]);
			files[file] = {
				match: false,
				packageHash: pkgHash,
				size: pkgSize,
				status: 'missing-in-source',
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

	const totalFiles = allFiles.size;
	const score = totalFiles > 0 ? matchingFiles / totalFiles : 1;

	return {
		files,
		summary: {
			differentFiles,
			matchingFiles,
			missingInPackage,
			missingInSource,
			score,
			totalFiles,
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
	const filtered = {};

	for (const file of Object.keys(result.files)) {
		if (!result.files[file].match) {
			filtered[file] = result.files[file];
		}
	}

	return {
		files: filtered,
		summary: result.summary,
	};
}
