// semantic-release: every push to main that holds a feat, fix, perf, refactor or revert commit publishes a new version
// to npm. npm builds the package itself (prepublishOnly).
// See .github/workflows/release.yml.
module.exports = {
  branches: ["main"],
  tagFormat: "v${version}",
  plugins: [
    [
      "@semantic-release/commit-analyzer",
      {
        preset: "conventionalcommits",
        releaseRules: [
          { type: "feat", release: "minor" },
          { type: "fix", release: "patch" },
          { type: "perf", release: "patch" },
          { type: "refactor", release: "patch" },
          { type: "revert", release: "patch" },
          { breaking: true, release: "major" },
        ],
      },
    ],
    [
      "@semantic-release/release-notes-generator",
      {
        preset: "conventionalcommits",
        presetConfig: {
          types: [
            { type: "feat", section: "Features" },
            { type: "fix", section: "Bug Fixes" },
            { type: "perf", section: "Performance" },
            { type: "revert", section: "Reverts" },
            { type: "refactor", section: "Refactoring", hidden: true },
            { type: "docs", hidden: true },
            { type: "chore", hidden: true },
            { type: "style", hidden: true },
            { type: "test", hidden: true },
            { type: "ci", hidden: true },
          ],
        },
      },
    ],
    // npm trusted publishing (OIDC): no token. It adds provenance by itself when the repository is public.
    "@semantic-release/npm",
    [
      "@semantic-release/git",
      {
        assets: ["package.json"],
        message: "chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
      },
    ],
    "@semantic-release/github",
    [
      "@semantic-release/exec",
      {
        successCmd: 'echo "published=true" >> "$GITHUB_OUTPUT" && echo "version=${nextRelease.version}" >> "$GITHUB_OUTPUT"',
      },
    ],
  ],
};
