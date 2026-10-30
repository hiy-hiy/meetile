module.exports = {
  testEnvironment: 'node',
  modulePathIgnorePatterns: [
    '<rootDir>/.tools/',
    '<rootDir>/apps/functions/deploy/',
    '<rootDir>/apps/mobile/dist/',
    '<rootDir>/apps/admin/.next/',
  ],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.cjs'],
  testMatch: ['<rootDir>/**/tests/**/*.test.ts'],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/deploy/',
    '/tests/emulators/',
    '/apps/mobile/',
  ],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.check.json' }],
  },
  moduleNameMapper: {
    '^@puzzle-sns/contracts$': '<rootDir>/packages/contracts/src/index.ts',
    '^@puzzle-sns/puzzle-engine$':
      '<rootDir>/packages/puzzle-engine/src/index.ts',
  },
  collectCoverageFrom: [
    'packages/*/src/**/*.ts',
    'tools/*/src/**/*.ts',
    'apps/functions/src/**/*.ts',
  ],
  coveragePathIgnorePatterns: ['/cli.ts$'],
};
