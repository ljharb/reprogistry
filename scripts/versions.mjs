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

let packumentResult;
try {
	packumentResult = await packument(`${pkg}@*`);
} catch (err) {
	if (err && err.code === 'E404') {
		// Verify the 404 by making a direct request to the npm registry
		const registryUrl = `https://registry.npmjs.org/${encodeURIComponent(pkg).replace('%40', '@')}`;
		const verifyResponse = await fetch(registryUrl);
		if (verifyResponse.status === 404) {
			console.log(`Package ${pkg} confirmed not found on npm (verified via registry), marking for removal`);
			setOutput('missingRepros', '');
			setOutput('removed', 'true');
			setOutput('removedReason', 'package no longer exists on npm');
			process.exit(0);
		}
		// If verification didn't confirm 404, treat as transient error
		console.error(`Package ${pkg} got E404 from pacote but registry returned ${verifyResponse.status}, treating as error`);
		throw err;
	}
	throw err; // re-throw non-404 errors
}
if (!packumentResult || !packumentResult.versions) {
	throw new Error(`Unexpected empty packument for ${pkg}`);
}

const versions = /** @type {Version[]} */ (Object.keys(packumentResult.versions));

// Handle packages that exist but have no published versions (all unpublished)
if (versions.length === 0) {
	console.log(`Package ${pkg} has no published versions, marking for removal`);
	setOutput('missingRepros', '');
	setOutput('removed', 'true');
	setOutput('removedReason', 'package has no published versions');
	process.exit(0);
}

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
