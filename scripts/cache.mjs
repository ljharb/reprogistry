import { readFile, writeFile } from 'fs/promises';
import path from 'path';

import { reproduce } from 'reproduce';
import { compare as semverCompare, Range } from 'semver';

const { PACKAGE: pkg, VERSIONS } = process.env;

const pkgDir = path.join(process.cwd(), 'data', 'results', /** @type {string} */ (pkg));

/** @typedef {`${number}.${number}.${number}${'' | '-${string}'}`} Version */
/** @typedef {import('reproduce').ReproduceResult} ReproduceResult */

const versions = /** @type {Version[]} */ (
	new Range(/** @type {string} */ (VERSIONS)).set.flat(1).map((x) => x.value)
);

const [
	results,
	existingData,
] = (
	await Promise.all(/** @type {const} */ ([
		Promise.all(versions.map(async (v) => reproduce(`${pkg}@${v}`))),
		/** @type {Promise<{ [k in Version]: ReproduceResult[] }>} */ (
			Promise.all(versions.map(async (v) => /** @type {const} */ ([
				v,
				/** @type {ReproduceResult[]} */ (JSON.parse(await readFile(path.join(pkgDir, v), 'utf8').catch(() => '[]'))),
			]))).then(Object.fromEntries)
		),
	]))
);

await Promise.all(results.map(async (result) => {
	if (!result) {
		return;
	}
	const dataPath = path.join(pkgDir, result.package.version.replace(/^v?/, 'v'));
	const existing = existingData[/** @type {Version} */ (result.package.version)] ?? [];

	existing.push(result);
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

	await writeFile(dataPath, JSON.stringify(existing, null, '\t') + '\n');
}));
