import { readFile } from 'fs/promises';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const { version: reproduceVersion } = require('reproduce/package.json');

import pacote from 'pacote';
const { packument } = pacote;

import { setOutput } from '@actions/core';

const { PACKAGE: pkg } = process.env;

const pkgDir = path.join(process.cwd(), 'data', 'results', /** @type {string} */ (pkg));

/** @typedef {`${number}.${number}.${number}${'' | '-${string}'}`} Version */
/** @typedef {import('reproduce').ReproduceResult} ReproduceResult */

const versions = /** @type {Version[]} */ (
	await packument(`${pkg}@*`).then(({ versions: vs }) => Object.keys(vs))
);

const existingEntries = await Promise.all(versions.map(async (v) => /** @type {const} */ ([
	v,
	/** @type {ReproduceResult[]} */ (JSON.parse(await readFile(path.join(pkgDir, v), 'utf8').catch(() => '[]'))),
])));
const existingData = /** @type {{ [k in typeof versions[number]]: ReproduceResult[] }} */ (
	Object.fromEntries(existingEntries)
);

const missingRepros = versions.filter((v) => {
	if (!(v in existingData) || !(existingData[v]?.length > 0)) {
		return true;
	}
	if (!existingData[v].some((r) => r.reproduceVersion === reproduceVersion)) {
		return true;
	}
	return false;
});

setOutput('missingRepros', missingRepros.join('||'));
