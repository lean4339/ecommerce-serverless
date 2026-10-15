import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier/flat';

export default defineConfig(
  {
    ignores: ['**/node_modules/**', '**/dist/**', 'backups/**', 'coverage/**'],
  },
  {
    files: ['api/**/*.ts', 'frontend/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    rules: {
      'one-var': ['error', 'never'],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  {
    files: ['frontend/src/data.ts'],
    rules: {
      // El adaptador heredado de la tienda acepta respuestas JSON de distintas rutas.
      // El resto del código TypeScript mantiene la regla recomendada contra `any`.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  // Prettier se encarga del formato; ESLint conserva los chequeos de código.
  prettier,
  {
    files: ['api/**/*.ts', 'frontend/**/*.{ts,tsx}'],
    // Exigir siempre llaves es compatible con Prettier y hace explícitos los bloques.
    rules: { curly: ['error', 'all'] },
  },
);
