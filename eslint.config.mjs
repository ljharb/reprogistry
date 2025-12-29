import baseConfig from '@ljharb/eslint-config/flat/node/latest';

export default [
	{
		ignores: ['dashboard/**'],
	},
	...baseConfig,
	{
		rules: {
			'max-len': 'off',
			'no-extra-parens': 'off',
		},
	},
	{
		files: ['scripts/reproduce.js'],
		rules: {
			complexity: 'off',
			'func-style': 'off',
			'max-lines-per-function': 'off',
			'max-statements': 'off',
			'no-param-reassign': 'off',
			'no-underscore-dangle': 'off',
			'no-var': 'off',
			'object-shorthand': 'off',
			'prefer-const': 'off',
			'prefer-destructuring': 'off',
			'prefer-object-spread': 'off',
			'prefer-template': 'off',
			'sort-keys': 'off',
			strict: ['error', 'global'],
		},
	},
];
