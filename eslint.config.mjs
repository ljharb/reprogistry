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
];
