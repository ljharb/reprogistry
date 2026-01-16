#!/usr/bin/env node

import pacote from 'pacote';
import pargs from 'pargs';
import npa from 'npm-package-arg';
import parsePURL from 'purl/parse';
import validPURL from 'purl/valid';
import { getTier } from './tiers.mjs';

const BASE_URL = 'https://raw.githubusercontent.com/reprogistry/reprogistry/precompute/packages';

const {
	help,
	positionals,
	values,
} = await pargs(import.meta.filename, {
	allowPositionals: true,
	options: {
		json: {
			description: 'Output as JSON',
			short: 'j',
			type: 'boolean',
		},
		purl: {
			description: 'Treat input as a PURL',
			short: 'p',
			type: 'boolean',
		},
	},
});

await help();

if (positionals.length === 0) {
	console.error('Error: A package specifier or PURL is required');
	process.exit(1);
}

const input = positionals[0];
let spec;

if (values.purl) {
	if (!validPURL(input)) {
		console.error('Error: Invalid PURL:', input);
		process.exit(1);
	}

	const parsed = parsePURL(input);
	if (!parsed) {
		console.error('Error: Failed to parse PURL:', input);
		process.exit(1);
	}
	if (parsed.type !== 'npm') {
		console.error('Error: Only npm PURLs are supported. Got type:', parsed.type);
		process.exit(1);
	}

	const name = parsed.namespace ? `${parsed.namespace}/${parsed.name}` : parsed.name;
	spec = {
		name,
		rawSpec: parsed.version || 'latest',
		version: parsed.version,
	};
} else {
	try {
		spec = npa(input);
	} catch (e) {
		const err = /** @type {Error} */ (e);
		console.error('Error: Invalid package specifier:', input);
		console.error(err.message);
		process.exit(1);
	}
}

const packageName = spec.name;
if (!packageName) {
	console.error('Error: Could not determine package name');
	process.exit(1);
}

// Resolve the version using pacote (handles ranges, tags, etc.)
const rawVersion = spec.rawSpec || spec.fetchSpec || 'latest';
const npmSpec = `${packageName}@${rawVersion}`;
let resolvedVersion;
/** @type {Record<string, string> | undefined} */
let dependencies;
try {
	const manifest = await pacote.manifest(npmSpec);
	resolvedVersion = manifest.version;
	({ dependencies } = manifest);
} catch {
	// If pacote can't resolve (e.g., package doesn't exist), use the raw version
	resolvedVersion = rawVersion;
}

// Fetch precomputed package data
const safePackageName = packageName.replace('/', '__');
const dataUrl = `${BASE_URL}/${safePackageName}.json`;
const response = await fetch(dataUrl, { cache: 'no-store' });

if (!response.ok) {
	if (values.json) {
		console.log(JSON.stringify({
			name: packageName,
			status: 'not-tracked',
			version: resolvedVersion,
		}));
	} else {
		console.log(`Package: ${packageName}`);
		console.log(`Version: ${resolvedVersion}`);
		console.log('\nStatus: Not tracked by reprogistry');
	}
	process.exit(0);
}

const data = await response.json();

// Find the resolved version in the precomputed data
/** @param {{ version: string }} v */
const matchesVersion = (v) => v.version === resolvedVersion;
const versionData = data.versions && data.versions.find(matchesVersion);

if (!versionData) {
	if (values.json) {
		console.log(JSON.stringify({
			name: packageName,
			status: 'version-not-found',
			version: resolvedVersion,
		}));
	} else {
		console.log(`Package: ${packageName}`);
		console.log(`Version: ${resolvedVersion}`);
		console.log('\nStatus: Version not found in reprogistry data');
	}
	process.exit(0);
}

// Handle both data formats: simple (score directly) and rich (score in latestResult)
/** @type {number | null | undefined} */
const versionScore = typeof versionData.score === 'number'
	? versionData.score
	: versionData.latestResult?.score;
const versionReproduced = typeof versionData.reproduced === 'boolean'
	? versionData.reproduced
	: versionData.latestResult?.reproduced;

const tier = getTier(versionScore);

// Get transitive dependencies from precomputed data (rich format) or fall back to direct deps
const prodDeps = versionData.prodDependencies
	|| versionData.latestResult?.prodDependencies
	|| [];
// If we have prodDependencies, use those (transitive); otherwise fall back to direct deps from manifest
const depNames = prodDeps.length > 0
	? [...new Set(prodDeps.map((/** @type {{ name: string }} */ d) => d.name))]
	: (dependencies ? Object.keys(dependencies) : []);

// Fetch dependency reproducibility data
/** @type {{ name: string, score: number | null, tier: string, tracked: boolean }[]} */
const depResults = [];

if (depNames.length > 0) {
	const depFetches = depNames.map(async (depName) => {
		const safeDep = depName.replace('/', '__');
		const depUrl = `${BASE_URL}/${safeDep}.json`;
		try {
			const depResponse = await fetch(depUrl, { cache: 'no-store' });
			if (!depResponse.ok) {
				return {
					name: depName,
					score: null,
					tier: 'Unknown',
					tracked: false,
				};
			}
			const depData = await depResponse.json();
			// Get latest version's score (handle both simple and rich formats)
			const latestVersion = depData.versions && depData.versions[0];
			if (latestVersion) {
				const depScore = typeof latestVersion.score === 'number'
					? latestVersion.score
					: latestVersion.latestResult?.score;
				if (typeof depScore === 'number') {
					return {
						name: depName,
						score: depScore,
						tier: getTier(depScore),
						tracked: true,
					};
				}
			}
			return {
				name: depName,
				score: null,
				tier: 'Unknown',
				tracked: true,
			};
		} catch {
			return {
				name: depName,
				score: null,
				tier: 'Unknown',
				tracked: false,
			};
		}
	});
	depResults.push(...await Promise.all(depFetches));
}

const trackedDeps = depResults.filter((d) => d.tracked);
const trackedWithScore = trackedDeps.filter((d) => d.score !== null);
const avgScore = trackedWithScore.length > 0
	? trackedWithScore.reduce((sum, d) => sum + /** @type {number} */ (d.score), 0) / trackedWithScore.length
	: null;

const depStats = {
	averageScore: avgScore,
	averageTier: getTier(avgScore),
	missing: depResults.filter((d) => !d.tracked).length,
	total: depResults.length,
	tracked: trackedDeps.length,
};

if (values.json) {
	console.log(JSON.stringify({
		dependencies: depStats,
		name: packageName,
		reproduced: versionReproduced,
		score: versionScore,
		status: versionReproduced ? 'reproducible' : 'not-reproducible',
		tier,
		version: versionData.version,
	}));
} else {
	console.log(`Package: ${packageName}`);
	console.log(`Version: ${versionData.version}`);
	if (typeof versionScore === 'number') {
		const pct = (versionScore * 100).toFixed(1);
		console.log(`\nReproducibility: ${pct}% (${tier})`);
	} else {
		console.log('\nReproducibility: No data available');
	}

	if (depStats.total > 0) {
		console.log(`\nTransitive Dependencies: ${depStats.total} total, ${depStats.tracked} tracked, ${depStats.missing} missing`);
		if (depStats.averageScore !== null) {
			const avgPct = (depStats.averageScore * 100).toFixed(1);
			console.log(`Average Score: ${avgPct}% (${depStats.averageTier})`);
		}
		// Only show high-risk dependencies
		const highRiskDeps = depResults.filter((d) => d.tier === 'High Risk');
		if (highRiskDeps.length > 0) {
			console.log('\nHigh Risk:');
			for (const dep of highRiskDeps) {
				const depPct = (/** @type {number} */ (dep.score) * 100).toFixed(1);
				console.log(`  ${dep.name}: ${depPct}%`);
			}
		}
	} else {
		console.log('\nTransitive Dependencies: None');
	}
}
