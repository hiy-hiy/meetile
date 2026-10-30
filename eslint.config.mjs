import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '.tools/**',
      '**/.expo/**',
      'apps/admin/.next/**',
      'apps/admin/next-env.d.ts',
      'apps/mobile/ios/**',
      'apps/mobile/src/local/gallery-demo/assets.local/**',
      'apps/mobile/android/**',
      'apps/mobile/modules/*/android/build/**',
      'apps/mobile/modules/*/android/.gradle/**',
      'coverage/**',
      'artifacts/**',
      '**/deploy/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ['**/*.{ts,tsx}'],
  })),
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        project: [
          './tsconfig.check.json',
          './apps/mobile/tsconfig.json',
          './apps/admin/tsconfig.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.mjs', '**/*.cjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        module: 'readonly',
        require: 'readonly',
        __dirname: 'readonly',
        fetch: 'readonly',
        AbortSignal: 'readonly',
      },
    },
  },
  {
    files: [
      '**/tests/**/*.test.ts',
      '**/tests/**/*.test.tsx',
      'tests/emulators/*.test.ts',
    ],
    rules: {
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
);
