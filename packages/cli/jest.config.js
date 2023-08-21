/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: [
    "<rootDir>/test/**/*.ts?(x)",
    "<rootDir>/test/**/?(*.)+(spec|test).ts?(x)",
    "<rootDir>/src/**/?(*.)+(spec|test).ts?(x)"
  ],
};