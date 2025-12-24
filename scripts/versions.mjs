import { readFile } from 'fs/promises';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const { version: reproduceVersion } = require('reproduce/package.json');

import pacote from 'pacote';
const { packument } = pacote;

import { setOutput } from '@actions/core';

import COMPARISON_HASH from './comparison-hash.mjs';

const { PACKAGE: pkg } = process.env;

const pkgDir = path.join(process.cwd(), 'data', 'results', /** @type {string} */ (pkg));

/** @typedef {`${number}.${number}.${number}${'' | '-${string}'}`} Version */
/** @typedef {import('reproduce').ReproduceResult & { diff?: object, comparisonHash?: string }} EnhancedResult */

const versions = /** @type {Version[]} */ (
	await packument(`${pkg}@*`).then(({ versions: vs }) => Object.keys(vs))
);

const existingEntries = await Promise.all(versions.map(async (v) => /** @type {const} */ ([
	v,
	/** @type {EnhancedResult[]} */ (JSON.parse(await readFile(path.join(pkgDir, v.replace(/^v?/, 'v')), 'utf8').catch(() => '[]'))),
])));
const existingData = /** @type {{ [k in typeof versions[number]]: EnhancedResult[] }} */ (
	Object.fromEntries(existingEntries)
);

const missingRepros = versions.filter((v) => {
	if (!(v in existingData) || !(existingData[v]?.length > 0)) {
		return true;
	}
	// Use findLast to get the most recent result (array is sorted oldest-first)
	const latestResult = existingData[v].findLast((r) => r.reproduceVersion === reproduceVersion);
	// Recheck if no result with current reproduce version
	if (!latestResult) {
		return true;
	}
	// Recheck if result is missing diff info or has old comparison hash
	if (!latestResult.diff || latestResult.comparisonHash !== COMPARISON_HASH) {
		return true;
	}
	return false;
});

setOutput('missingRepros', missingRepros.join('||'));
