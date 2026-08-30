# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root.
- **`docs/SPEC.md`** for the normative product/technical specification.
- **`docs/adr/`** for architectural decisions relevant to the area being changed.

If any of these files don't exist yet, proceed silently. They will be created as the project decisions solidify.

## File structure

Single-context repo:

```
/
|- CONTEXT.md
|- docs/SPEC.md
|- docs/adr/
\- src/
```

## Use the glossary's vocabulary

When output names a domain concept, prefer the terms defined in `CONTEXT.md`
(preview, preview database, shared instance, sidecar, provider, hand over,
sweep, PR id). If a concept is missing, either reconsider the term or note it
as a gap to be modeled.

## Flag ADR conflicts

If a proposal contradicts an existing ADR, surface the conflict explicitly
instead of silently overriding it.
