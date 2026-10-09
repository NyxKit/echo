import nyxConfig from 'nyx-kit/eslint'

export default [
  { ignores: ['data/**', 'node_modules/**', 'dist/**', 'build/**', 'release/**',
    'coverage/**', 'playwright-report/**', 'test-results/**'] },
  ...nyxConfig,
  {
    // Adopt correctness checks without reformatting existing application code.
    rules: { 'max-len': 'off', 'vue/max-len': 'off' },
  },
  {
    files: ['tests/**/*.ts'],
    // Tests inspect untyped JSON transport payloads.
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
]
