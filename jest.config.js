/**
 * The action's dependencies — `@actions/core`, `@actions/github`, `ai` — publish ESM only, with
 * no `require` condition to resolve. Jest therefore runs the tests as ES modules, which needs
 * `--experimental-vm-modules` (see the `test` script) and ts-jest emitting ESM.
 */
module.exports = {
  clearMocks: true,
  extensionsToTreatAsEsm: ['.ts'],
  moduleFileExtensions: ['js', 'ts'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { useESM: true, tsconfig: 'tsconfig.test.json' }]
  },
  verbose: true
};
