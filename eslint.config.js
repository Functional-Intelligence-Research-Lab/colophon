export default [
  {
    // Skip vendored third-party libraries (e.g. JSZip)
    ignores: ['src/lib/jszip.js', 'src/lib/jszip.min.js', 'node_modules/**', 'dist/**'],
  },
  {
    files: ['src/**/*.js'],
    rules: {
      'no-unused-vars':    ['warn', { argsIgnorePattern: '^_' }],
      'no-console':        'off',
      'eqeqeq':            ['error', 'always'],
      'no-var':            'error',
      'prefer-const':      'error',
      'no-implicit-globals': 'error',
    },
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        chrome:  'readonly',
        crypto:  'readonly',
        URL:     'readonly',
        Blob:    'readonly',
        TextEncoder: 'readonly',
      },
    },
  },
]
