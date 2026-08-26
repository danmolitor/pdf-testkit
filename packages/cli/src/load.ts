// The load logic lives in core so the CLI and the GitHub Action share one
// implementation. Re-exported here under the name the CLI already used.
export { loadSnapshotFromFile as loadAsSnapshot } from '@pdf-testkit/core';
