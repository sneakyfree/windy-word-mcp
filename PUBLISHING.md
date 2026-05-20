# Publishing windy-word-mcp

This document captures the exact steps to release a new version of `windy-word-mcp`
to npm and the MCP registry, so future-you doesn't have to re-derive them.

## 1. Bump version

Update `version` in three places (they must match):

- `package.json` → `"version"`
- `server.json` → top-level `"version"`
- `server.json` → `packages[0].version`

```bash
# Example for 0.1.1
npm version 0.1.1 --no-git-tag-version
# Then manually sync server.json (or write a release script later).
```

Commit + tag:

```bash
git add package.json server.json
git commit -m "Release v0.1.1"
git tag v0.1.1
git push && git push --tags
```

## 2. npm publish

Requires npm auth on this machine. One-time setup:

```bash
# Option A — interactive login (opens browser, fastest)
npm login

# Option B — automation token (good for CI; save to lockbox)
# 1. https://www.npmjs.com/settings/<username>/tokens → "Generate New Token" → Automation
# 2. echo "//registry.npmjs.org/:_authToken=npm_xxxxxxxx" >> ~/.npmrc
```

Verify with `npm whoami`, then publish:

```bash
npm publish --access public
```

Verify on https://www.npmjs.com/package/windy-word-mcp.

## 3. MCP registry submission

Install the publisher tool (one-time):

```bash
brew install mcp-publisher           # macOS / Linux
# OR build from source:
# git clone https://github.com/modelcontextprotocol/registry && cd registry && make publisher
```

Authenticate (one-time per machine):

```bash
# The repo is sneakyfree/windy-word-mcp on GitHub, so we use GitHub OAuth
# to claim the io.github.sneakyfree/* namespace.
mcp-publisher login github
```

Publish (every release, from this repo's root):

```bash
mcp-publisher publish
```

The publisher reads `server.json` from the current directory, verifies that
the npm package at `packages[0].identifier@version` exists, confirms namespace
ownership, and submits.

Verify on https://registry.modelcontextprotocol.io.

## 4. Update Claude Code / Claude Desktop installations

Once published, end users can install with:

```bash
claude mcp add windy-word --command "npx" --args "-y" "windy-word-mcp"
```

Bumping the version on already-installed clients is automatic with `npx -y`.

## Notes

- Namespace `io.github.sneakyfree/*` is locked to the GitHub user `sneakyfree`.
  Switching to `ai.windyword/*` would require a DNS TXT record on windyword.ai —
  defer until v1.0 or until ecosystem-wide branding consolidation.
- The MCP registry only accepts packages from the public npm registry
  (`https://registry.npmjs.org`). Private registries / GitHub Packages are rejected.
- Package versions must match across `package.json`, `server.json`, and the
  actual npm publish. The publisher tool validates this at submission time.
