# Hippo Vault (versioned mirror)

This is a **read-only mirror** of the Hippo Obsidian vault — the project's
canonical strategy, build plan, decisions, and reference docs — checked into
git so the whole team (and their agents) can read it and so every revision is
versioned.

- **Source of truth for editing:** the Obsidian vault (iCloud →
  `Documents/Hippo`). Edit there, not here.
- **To update this mirror:** run `./scripts/sync-vault.sh` from the repo root,
  review `git diff docs/vault`, commit. Each sync is one commit — that is the
  version history.
- Obsidian `[[wiki-links]]` are kept verbatim; GitHub renders them as plain
  text. Open the folder in Obsidian for full link navigation.
- `.obsidian/` workspace config is deliberately excluded.

## Map

| Folder | What lives there |
|---|---|
| `Build Plan/00–11` | The build plan: architecture, SDK, intelligence, seam, CLI, evals, infra, PRD, FE/BE architecture, agentic integration & user flows |
| `Strategy/` | The master strategy memo + frontend baseline |
| `Decisions/Open Decisions.md` | The live decision register |
| `Reference/` | Brand guidelines + tokens, data model, dev docs, prototype snapshot |
| `Roadmap.md` | Done vs pending, by phase and workstream |
| `Home.md` | Vault hub |
