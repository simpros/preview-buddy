# Issue tracker: GitHub

Issues, the spec, and their breakdown live as GitHub issues on
`simpros/preview-buddy`. Use the [`gh`](https://cli.github.com) CLI for all
operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a
  heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`. Use `--json` for
  machine-readable output.
- **List issues**: `gh issue list --json number,title,labels` with
  appropriate filters.
- **Comment**: `gh issue comment <number> --body "..."`.
- **Label**: `gh issue edit <number> --add-label "..."` /
  `--remove-label "..."`.
- **Close**: `gh issue close <number> --comment "..."`.

Infer the repo from `git remote -v` — `gh` does this automatically when run
inside a clone.

## Spec-derived work

The normative source for what to build is `docs/SPEC.md`. Issues reference
the spec section they implement (`Spec: §N`) and the ADRs they must respect
(`ADRs: platform/0003, domain/0001`). When an issue contradicts the spec or
an ADR, flag it instead of silently picking one.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.
