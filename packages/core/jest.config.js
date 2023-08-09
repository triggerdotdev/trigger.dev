module.exports = {
  moduleFileExtensions: ["ts", "tsx", "js"],
  transform: {
    "^.+\\.(ts|tsx)$": "ts-jest",
  },
  testMatch: ["<rootDir>/test/**/*.ts?(x)", "<rootDir>/test/**/?(*.)+(spec|test).ts?(x)"],
  testEnvironment: "node",
};
