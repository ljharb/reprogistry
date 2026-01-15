import baseConfig from '@ljharb/eslint-config/flat/node/latest';

import nodeConfig from '@ljharb/eslint-config/flat/node/22';

export default [
	{
		ignores: ['dashboard/**'],
	},
	...baseConfig,
	{
		rules: {
			'func-style': 'off',
			'max-len': 'off',
			'no-extra-parens': 'off',
		},
	},
	{
		files: ['scripts/reproduce.mjs'],
		rules: {
			'array-bracket-newline': 'off',
			complexity: 'off',
			'max-depth': 'off',
			'max-lines': 'off',
			'max-lines-per-function': 'off',
			'max-statements': 'off',
			'no-underscore-dangle': 'off',
			'sort-keys': 'off',
		},
	},
	...nodeConfig.map((config) => ({
		...config,
		files: config.files
			? config.files.map((file) => `packages/cli/${file}`)
			: ['packages/cli/**'],
	})),
	{
		files: ['packages/cli/**/*.mjs'],
		rules: {
			'no-extra-parens': 'off',
		},
	},
];
