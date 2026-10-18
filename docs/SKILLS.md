# Interleaf — Installed Project Skills Registry

> **Read. Think. Build.**  
> Project-Local Agent Skills, Mandatory Architectural Guidelines, and Source Revisions.

---

## 1. Skills Catalog Provenance

All project-local skill copies were obtained from the catalog repository and pinned to the following catalog revision. Each installed `SKILL.md` remains authoritative for its original upstream metadata/source:

- **Source Repository**: `https://github.com/sickn33/agentic-awesome-skills`
- **Pinned Catalog Revision**: `b6ceca367a3b3ee90a273a3afa895960e8e9d7a5`

---

## 2. Installed Skills Directory & Workstream Mapping

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   INSTALLED SKILLS REGISTRY                                     │
├──────────────────────────────────┬───────────┬──────────────────────────────────────────────────┤
│ Skill Name                       │ Status    │ Assigned Subagents & Usage Mandate               │
├──────────────────────────────────┼───────────┼──────────────────────────────────────────────────┤
│ **`electron-development`**       │ Mandatory │ Architecture, Security, Main Process Agents.     │
│                                  │           │ MUST consult before modifying BrowserWindow, IPC,│
│                                  │           │ preload scripts, or packaging specs.             │
├──────────────────────────────────┼───────────┼──────────────────────────────────────────────────┤
│ **`security-and-hardening`**     │ Mandatory │ Security, AI, and Agent Runtime Agents.          │
│                                  │           │ Enforces path traversal guards, prompt injection │
│                                  │           │ defenses, secret redaction, and CSP.             │
├──────────────────────────────────┼───────────┼──────────────────────────────────────────────────┤
│ **`database-design`**            │ Mandatory │ Architecture and Database Agents.                │
│                                  │           │ Governs SQLite table schemas, indexes, WAL mode, │
│                                  │           │ and FTS5 full-text search migrations.            │
├──────────────────────────────────┼───────────┼──────────────────────────────────────────────────┤
│ **`using-git-worktrees`**        │ Mandatory │ Agent Runtime Agent.                             │
│                                  │           │ Governs `git worktree` isolation, branch         │
│                                  │           │ creation, patch extraction, and cleanup logic.   │
├──────────────────────────────────┼───────────┼──────────────────────────────────────────────────┤
│ **`react-best-practices`**       │ Mandatory │ UI & Renderer Feature Agents.                    │
│                                  │           │ Enforces React 19 performance, render            │
│                                  │           │ virtualization, and efficient Zustand stores.    │
├──────────────────────────────────┼───────────┼──────────────────────────────────────────────────┤
│ **`typescript-expert`**          │ Mandatory │ All Subagents.                                   │
│                                  │           │ Enforces strict TypeScript types, discriminated  │
│                                  │           │ unions for anchors/events, and zero `any`.       │
├──────────────────────────────────┼───────────┼──────────────────────────────────────────────────┤
│ **`playwright-skill`**           │ Mandatory │ Test & QA Agents.                                │
│                                  │           │ Governs Electron Playwright testing, IPC         │
│                                  │           │ mocking, and E2E workflow verification (A–J).    │
├──────────────────────────────────┼───────────┼──────────────────────────────────────────────────┤
│ **`accessibility-compliance-`**   │ Mandatory │ UI & Reader Design Agents.                       │
│ **`accessibility-audit`**         │           │ Governs WCAG AA keyboard navigation,            │
│                                  │           │ focus rings, ARIA roles, and palette contrast.  │
└──────────────────────────────────┴───────────┴──────────────────────────────────────────────────┘
```

---

## 3. Mandatory Usage Rules for Implementing Agents

1. **Electron Boundary Changes**: No agent may alter `webPreferences`, add an IPC channel, modify preload exposure, or register custom protocols without validating compliance against `electron-development`.
2. **Database Schema Changes**: Any new SQLite table or index must adhere to principles defined in `database-design` and be recorded in `docs/DATABASE.md`.
3. **Workspace Isolation Logic**: The agent runtime's `git worktree` implementation must adhere to patterns established in `using-git-worktrees`.
4. **Accessible UI Controls**: All newly generated buttons, dropdowns, and dialogs must pass keyboard focus and screen reader checks per `accessibility-compliance-accessibility-audit`.
