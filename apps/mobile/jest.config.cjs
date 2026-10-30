module.exports = {
  preset: 'jest-expo',
  testMatch: ['<rootDir>/tests/**/*.test.ts', '<rootDir>/tests/**/*.test.tsx'],
  moduleNameMapper: {
    '^@puzzle-sns/gallery-demo-assets$':
      '<rootDir>/src/local/gallery-demo/no-assets.ts',
    '^@puzzle-sns/proximity-observer$':
      '<rootDir>/src/cloud/proximity-observer.ts',
    '^@puzzle-sns/contracts$':
      '<rootDir>/../../packages/contracts/src/index.ts',
    '^@puzzle-sns/design$': '<rootDir>/../../packages/design/src/index.ts',
  },
  transformIgnorePatterns: [
    'node_modules/(?!((?:.pnpm/)?(?:@?react-native|react-native|expo|@expo|@unimodules|@react-navigation|unicode-segmenter)))',
  ],
  collectCoverage: false,
};
