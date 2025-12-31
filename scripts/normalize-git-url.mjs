/**
 * Normalize various git URL formats to HTTPS URLs.
 *
 * Handles:
 * - git+https://github.com/org/repo.git
 * - git://github.com/org/repo.git
 * - ssh://git@github.com/org/repo.git
 * - git@github.com:org/repo.git
 *
 * @param {string} url - The git URL to normalize
 * @returns {string} Normalized HTTPS URL
 */
export default function normalizeGitUrl(url) {
	return url
		.replace(/^git\+/, '')
		.replace(/^git:\/\//, 'https://')
		.replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/')
		.replace(/^git@github\.com:/, 'https://github.com/');
}
