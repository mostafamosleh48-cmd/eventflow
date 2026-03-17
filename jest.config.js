/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  setupFiles: ['dotenv/config'],
  collectCoverageFrom: ['src/**/*.ts', '!src/db/migrations/**'],
  coverageDirectory: 'coverage',
  transformIgnorePatterns: ['node_modules/(?!pg-boss)'],
  // Run tests sequentially — integration tests share a single PostgreSQL database
  maxWorkers: 1,
  verbose: true,
};
