const base = require('./jest.config.cjs');
module.exports = {
  ...base,
  testMatch: ['<rootDir>/tests/emulators/**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/deploy/'],
  testTimeout: 60000,
  collectCoverage: false,
};
