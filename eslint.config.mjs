import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/', '.vite/', 'out/', '.plugins/', 'coverage/', 'test-results/', 'playwright-report/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/renderer/**/*.ts', 'src/preload/**/*.ts'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // 红线：协议主机名 / origin 只能通过 HOST、ORIGIN 常量引用（测试与 Vite dev server 配置除外）
    files: ['src/**/*.ts', 'plugins/**/*.ts', 'scripts/**/*.ts', 'forge/**/*.ts', '*.ts'],
    ignores: ['src/shared/ipc.ts', 'src/main/chttp/scheme.ts', 'vite.*.config.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/chttp:\\/\\/localhost/]',
          message: 'Use ORIGIN from @shared/ipc instead of a chttp://localhost literal.',
        },
        {
          selector: 'TemplateElement[value.raw=/chttp:\\/\\/localhost/]',
          message: 'Use ORIGIN from @shared/ipc instead of a chttp://localhost literal.',
        },
      ],
    },
  },
);
