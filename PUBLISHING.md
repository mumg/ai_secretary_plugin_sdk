# Publishing the Node.js SDK

1. Confirm that the npm account can publish in the `@ai-secretary` scope. A GitHub repository does not grant access to an npm scope. If the scope belongs to another npm account, change the package name and README import before publishing.
2. Run `npm test` and `npm pack --dry-run --json` from this directory. Inspect the tarball file list; it must contain only the SDK entry points, README, license, and `package.json`.
3. Run `npm publish --dry-run --access public` and inspect its output. `prepublishOnly` runs the tests.
4. Sign in to npm (`npm login`) or use an authorized publishing method, then run `npm publish --access public` from this directory. npm may request a one-time code.
5. Check the published package at `https://www.npmjs.com/package/@ai-secretary/plugin-sdk` and install that exact version in a clean project.

The SDK has its own semantic version (`0.1.0` for its first publication). Release a new SDK version for any later change to a published tarball. The application's root `version` follows separate repository rules.
