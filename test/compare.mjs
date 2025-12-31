import test from 'tape';

import { filterNonMatching } from '../scripts/compare.mjs';

test('filterNonMatching', (t) => {
	t.test('filters out matching files', (st) => {
		const result = {
			files: {
				'index.js': { match: true, status: 'match', packageHash: 'abc', sourceHash: 'abc' },
				'lib/util.js': { match: false, status: 'content', packageHash: 'abc', sourceHash: 'def' },
				'README.md': { match: true, status: 'match', packageHash: 'xyz', sourceHash: 'xyz' },
			},
			summary: {
				totalFiles: 3,
				matchingFiles: 2,
				differentFiles: 1,
				missingInSource: 0,
				missingInPackage: 0,
				score: 0.67,
			},
		};

		const filtered = filterNonMatching(result);

		st.deepEqual(Object.keys(filtered.files), ['lib/util.js'], 'only non-matching files remain');
		st.deepEqual(filtered.summary, result.summary, 'summary is preserved');
		st.end();
	});

	t.test('preserves missing files', (st) => {
		const result = {
			files: {
				'index.js': { match: true, status: 'match' },
				'extra.js': { match: false, status: 'missing-in-source', packageHash: 'abc' },
				'missing.js': { match: false, status: 'missing-in-package' },
			},
			summary: {
				totalFiles: 3,
				matchingFiles: 1,
				differentFiles: 0,
				missingInSource: 1,
				missingInPackage: 1,
				score: 0.33,
			},
		};

		const filtered = filterNonMatching(result);

		st.deepEqual(
			Object.keys(filtered.files).sort(),
			['extra.js', 'missing.js'],
			'missing files are preserved',
		);
		st.end();
	});

	t.test('returns empty files object when all match', (st) => {
		const result = {
			files: {
				'a.js': { match: true, status: 'match' },
				'b.js': { match: true, status: 'match' },
			},
			summary: {
				totalFiles: 2,
				matchingFiles: 2,
				differentFiles: 0,
				missingInSource: 0,
				missingInPackage: 0,
				score: 1,
			},
		};

		const filtered = filterNonMatching(result);

		st.deepEqual(filtered.files, {}, 'files object is empty');
		st.equal(filtered.summary.score, 1, 'score is preserved');
		st.end();
	});

	t.end();
});
