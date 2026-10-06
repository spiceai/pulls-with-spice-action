module.exports = {
  clearMocks: true,
  moduleFileExtensions: ['js', 'ts'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        diagnostics: {
          // ts-jest warns that NodeNext needs isolatedModules. The project typechecks
          // with tsc; this only keeps that warning out of the test run.
          ignoreCodes: [151002],
        },
      },
    ],
  },
  verbose: true
};
