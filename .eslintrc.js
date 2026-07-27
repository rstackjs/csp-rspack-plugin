module.exports = {
  extends: ['airbnb-base', 'prettier'],
  plugins: ['prettier'],
  env: {
    es6: true,
    node: true,
  },
  parserOptions: {
    ecmaVersion: 2022,
  },
  rules: {
    'prettier/prettier': ['error', { singleQuote: true }],
    'import/no-extraneous-dependencies': [
      'error',
      {
        devDependencies: [
          'test-utils/**/*',
          '**/*.test.mjs',
          'test-real-content-hash.mjs',
        ],
      },
    ],
    'import/no-dynamic-require': 'off',
    'global-require': 'off',
  },
  globals: {
    document: true,
  },
  settings: {
    'import/core-modules': ['@rspack/core'],
  },
  overrides: [
    {
      files: ['*.spec.js', '*.test.mjs', 'webpack-helpers.mjs'],
      parserOptions: {
        sourceType: 'module',
      },
      rules: {
        'import/extensions': 'off',
      },
      globals: {
        rs: true,
        afterAll: true,
        afterEach: true,
        beforeAll: true,
        beforeEach: true,
        describe: true,
        expect: true,
        it: true,
      },
    },
    {
      files: ['test-real-content-hash.mjs'],
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
  ],
};
