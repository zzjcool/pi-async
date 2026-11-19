# Contributing

## Pull requests

- All changes land via PR into `main`. Do not push directly to `main`.
- CI (`typecheck` + `test`) must be green before merge.
- Ask Alice for CR; do not merge your own PR.

## Tool surface changes

The tool surface is a frozen contract (`docs/CONTRACT.md` §3 and §12). Adding, removing, renaming or
changing the default registration of a tool is a contract change, not a refactor:

- add a new REV section to `docs/CONTRACT.md` (reason / impact / rollback switch, the shape used by §16,
  §18 and §22), plus an acceptance checklist and a CHANGELOG entry;
- write the migration note for existing sessions and stale registrations;
- update `tests/k-toolsurface.test.ts` and the §17 snippet list in the same PR.

Breaking changes are: removing or renaming a tool; changing an existing parameter's type, requiredness
or default; changing the returned payload or its `isError` semantics; or changing the default surface
(making an opt-in tool default, tightening or replacing its env switch, changing the default count). A
purely additive tool that stays unregistered by default still needs a REV, but may be labelled
non-breaking and only document how to enable it.

The sixth seat is already taken: `async_wait` occupies it while `PI_ASYNC_EXPOSE_WAIT=1`. A new
list/attach tool is therefore the seventh, or it replaces `async_wait` — it cannot use an empty slot.

## Team process (short)

- Alice coordinates; coding agents open PRs with a clear body (what changed, how verified).
- Prefer local box work over Cursor Cloud Agent when quotas are tight.
- No force-push to `main`; no merge without review when a reviewer is available.
