import baseConfig from '@ljharb/eslint-config/flat/node/latest';

export default [
	...baseConfig,
	{
		rules: {
			'max-len': 'off',
			'no-extra-parens': 'off',
		},
	},
];
