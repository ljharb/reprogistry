import test from 'tape';

import normalizeGitUrl from '../scripts/normalize-git-url.mjs';

test('normalizeGitUrl', (t) => {
	t.test('passes through https URLs unchanged', (st) => {
		st.equal(
			normalizeGitUrl('https://github.com/org/repo.git'),
			'https://github.com/org/repo.git',
		);
		st.equal(
			normalizeGitUrl('https://github.com/org/repo'),
			'https://github.com/org/repo',
		);
		st.end();
	});

	t.test('converts git+https:// to https://', (st) => {
		st.equal(
			normalizeGitUrl('git+https://github.com/org/repo.git'),
			'https://github.com/org/repo.git',
		);
		st.end();
	});

	t.test('converts git:// to https://', (st) => {
		st.equal(
			normalizeGitUrl('git://github.com/org/repo.git'),
			'https://github.com/org/repo.git',
		);
		st.end();
	});

	t.test('converts ssh://git@github.com/ to https://github.com/', (st) => {
		st.equal(
			normalizeGitUrl('ssh://git@github.com/org/repo.git'),
			'https://github.com/org/repo.git',
		);
		st.equal(
			normalizeGitUrl('ssh://git@github.com/browserify/resolve.git'),
			'https://github.com/browserify/resolve.git',
		);
		st.end();
	});

	t.test('converts git@github.com: to https://github.com/', (st) => {
		st.equal(
			normalizeGitUrl('git@github.com:org/repo.git'),
			'https://github.com/org/repo.git',
		);
		st.equal(
			normalizeGitUrl('git@github.com:ljharb/qs.git'),
			'https://github.com/ljharb/qs.git',
		);
		st.end();
	});

	t.test('handles combined prefixes', (st) => {
		st.equal(
			normalizeGitUrl('git+ssh://git@github.com/org/repo.git'),
			'https://github.com/org/repo.git',
		);
		st.end();
	});

	t.end();
});
