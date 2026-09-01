# Contributing

Small, focused changes are welcome.

1. Open an issue before starting a large feature.
2. Run `npm test` and the syntax checks in `.github/workflows/ci.yml`.
3. Do not include credentials, provider responses, or real session logs in tests or issues.
4. Keep provider failures isolated and preserve the default-off permission model.
5. Update `CHANGELOG.md` for user-visible changes.

Pull requests should explain what changed, why it is needed, and how it was verified.

## Releases

Releases use GitHub Releases and npm trusted publishing. The Git tag must exactly match `v` plus the version in `package.json`. Mark prereleases in GitHub to publish them under npm's `beta` tag.

The first npm publication may require a one-time manual bootstrap. Afterward, configure `release.yml` as the package's trusted publisher and remove long-lived npm publish tokens.
