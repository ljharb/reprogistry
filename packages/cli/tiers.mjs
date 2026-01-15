/**
 * Tier thresholds for reproducibility scores
 * @type {{ name: string, minScore: number }[]}
 */
export const TIERS = [
	{ minScore: 1, name: 'Perfect' },
	{ minScore: 0.99, name: 'Excellent' },
	{ minScore: 0.9, name: 'Good' },
	{ minScore: 0, name: 'High Risk' },
];

/**
 * Get the tier name based on score
 * @param {number | null | undefined} score
 * @returns {string}
 */
export function getTier(score) {
	if (score === null || score === undefined || typeof score !== 'number') {
		return 'Unknown';
	}
	for (const tier of TIERS) {
		if (score >= tier.minScore) {
			return tier.name;
		}
	}
	return 'High Risk';
}
