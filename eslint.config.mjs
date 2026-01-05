import baseConfig from '@ljharb/eslint-config/flat/node/latest';

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
];
