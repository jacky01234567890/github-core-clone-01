# github-core-clone-01 — a GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/jacky01234567890/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/jacky01234567890/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A single-process, dependency-free GitHub-compatible git forge written in
TypeScript for Node 22, using only the Node standard library. It serves four
surfaces from one in-memory store:

| Route | Surface |
| --- | --- |
| `GET /healthz` | Boot probe: 200 `{"ok":true}` |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack` (v2 and v0), `git-receive-pack` (v0). Full git object model (blob/tree/commit/tag, SHA-1), packfile parsing and generation (including deltas), pkt-line protocol with side-band-64k, report-status, delete-refs and ls-refs. Fast-forward enforcement per ref. |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, labels, issues, comments, pull requests, files, squash merges |
| `POST /api/graphql` | GitHub GraphQL v4: repository/issues/pull-requests queries and mutations, introspection, batched operations |
| `POST /mcp` | Model Context Protocol over Streamable HTTP (JSON-RPC 2.0): `server/discover`, `initialize`, `tools/list`, `tools/call` |

## Run it

```sh
node --experimental-strip-types main.ts
```

There is nothing to install. The program imports `node:http`, `node:crypto`,
`node:zlib` and its own modules only.

`main.ts` is the entry <-> environment lifecycle (bind an ephemeral port,
register it with `$MAKEFUN_ENV_URL`, poll until done, exit 0) and is kept as
shipped. `app.ts` is the server; `store.ts` is the single shared in-memory
store every surface reads and writes; `git.ts`, `rest.ts`, `graphql.ts` and
`mcp.ts` implement the four surfaces.

## Notes

- Auth: every API call presents `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`.
  A missing or wrong token is refused with 401; a repository under another
  owner is 404, never 403.
- Deterministic: no wall clock is stored. All timestamps the API reports are
  the fixed scenario epoch, and creation order is a sequence counter, so two
  runs on the same instance leave the same state.
- The token's owner is the scenario viewer (`adaiversen`); the scenario seed
  is fixed, so this login is fixed too.

## Licence

MIT — see `LICENSE`.
