# Publishing SyntaxStitch

GitHub does not automatically register a repository as a VS Code extension. This project publishes through GitHub Actions when a GitHub Release is created.

## One-Time Setup

1. Push this project to the public repository `neonash7777/SyntaxStitch`.
2. Create a publisher at the [Visual Studio Marketplace publisher portal](https://marketplace.visualstudio.com/manage).
3. In the GitHub repository, add an Actions variable named `VSCE_PUBLISHER` and set it to the public publisher ID.
4. Create an Azure DevOps Personal Access Token with **Marketplace > Manage** scope.
5. Add that token to the GitHub repository as the Actions secret `VSCE_PAT`. Never commit the token.

## Publish a Release

1. Choose the next [Semantic Version](https://semver.org/) and update `version` in `package.json`.
2. Move relevant entries from **Unreleased** to a dated version section in `CHANGELOG.md`.
3. Run `npm run test:publish` to validate the extension and unit matrix, then run `npm run package:vsix` to create the VSIX artifact.
4. Commit and push the release changes.
5. Create and publish a GitHub Release whose tag is the exact package version prefixed with `v`, such as `v0.1.0`.

Use patch versions for compatible fixes, minor versions for backward-compatible features, and major versions for breaking behavior or configuration changes. Versions below `1.0.0` may use minor bumps for meaningful behavioral refinements.

The **Publish Extension** workflow verifies that the release tag matches `package.json`, tests the extension under Xvfb, packages a `.vsix`, attaches it to the GitHub Release, and publishes it to the VS Code Marketplace.

The workflow can also be run manually. Leave **Publish to the VS Code Marketplace** unchecked to produce a test artifact without publishing.

## Local Package Check

```sh
npm run package:vsix
```

Current release artifact:

- File: `syntaxstitch-0.0.8.vsix`
- SHA256: `0565a5ce88053e8074c817af3e3d8f3df8aee7261346f6c87784ce82f82e1c8e`

This checksum can be used to verify the packaged extension before installation or distribution.

The checked-in publisher ID is `BrockNash`. GitHub Actions validates and applies `VSCE_PUBLISHER` before packaging or publishing.
