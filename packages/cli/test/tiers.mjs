import test from 'tape';
import { getTier, TIERS } from '../tiers.mjs';

test('TIERS', (t) => {
	t.ok(Array.isArray(TIERS), 'TIERS is an array');
	t.equal(TIERS.length, 4, 'has 4 tiers');

	t.deepEqual(
		TIERS.map((tier) => tier.name),
		['Perfect', 'Excellent', 'Good', 'High Risk'],
		'tiers are in correct order',
	);

	t.equal(TIERS[0].minScore, 1, 'Perfect requires score of 1');
	t.equal(TIERS[1].minScore, 0.99, 'Excellent requires score >= 0.99');
	t.equal(TIERS[2].minScore, 0.9, 'Good requires score >= 0.9');
	t.equal(TIERS[3].minScore, 0, 'High Risk has minScore of 0');

	t.end();
});

test('getTier', (t) => {
	t.test('returns correct tier for scores', (st) => {
		st.equal(getTier(1), 'Perfect', 'score 1 is Perfect');
		st.equal(getTier(0.9999), 'Excellent', 'score 0.9999 is Excellent');
		st.equal(getTier(0.99), 'Excellent', 'score 0.99 is Excellent');
		st.equal(getTier(0.95), 'Good', 'score 0.95 is Good');
		st.equal(getTier(0.9), 'Good', 'score 0.9 is Good');
		st.equal(getTier(0.89), 'High Risk', 'score 0.89 is High Risk');
		st.equal(getTier(0.5), 'High Risk', 'score 0.5 is High Risk');
		st.equal(getTier(0), 'High Risk', 'score 0 is High Risk');
		st.equal(getTier(-1), 'High Risk', 'negative score is High Risk');
		st.end();
	});

	t.test('handles edge cases', (st) => {
		st.equal(getTier(null), 'Unknown', 'null returns Unknown');
		st.equal(getTier(undefined), 'Unknown', 'undefined returns Unknown');
		// @ts-expect-error testing invalid input
		st.equal(getTier('0.95'), 'Unknown', 'string returns Unknown');
		// @ts-expect-error testing invalid input
		st.equal(getTier({}), 'Unknown', 'object returns Unknown');
		st.end();
	});

	t.end();
});
