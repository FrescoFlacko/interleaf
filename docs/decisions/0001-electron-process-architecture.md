# ADR 0001: Electron Multi-Process Architecture & IPC Boundary

## Status
Accepted

## Context & Problem Statement
Interleaf is a desktop application combining document rendering (PDF, EPUB, MOBI, DOCX), local SQLite database storage, native OS integrations, and external AI/agent process execution. Document files may originate from untrusted sources and contain malicious scripts or malformed binary streams. Exposing Node.js primitives or arbitrary filesystem APIs to the renderer creates remote code execution (RCE) and data exfiltration vulnerabilities.

## Decision Drivers
- Absolute isolation of untrusted document rendering from privileged Node.js APIs.
- Conformance with the mandatory `electron-development` skill security checklist.
- Strict type safety and runtime validation for all inter-process communication.
- Responsive, non-blocking UI during heavy background indexing and AI streaming.

## Considered Options
1. **Option 1: Electron with `nodeIntegration: true`** — Legacy pattern allowing direct Node.js calls in React components.
2. **Option 2: Unsandboxed Electron with Preload Bridge** — Context isolation enabled, but sandbox disabled.
3. **Option 3: Fully Hardened Sandboxed Multi-Process Model** — `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, narrow typed `contextBridge`, strict CSP, and custom protocol handlers.

## Decision Outcome
Chosen **Option 3**.

### Architectural Invariants
1. **Window WebPreferences**:
   ```typescript
   webPreferences: {
     contextIsolation: true,
     nodeIntegration: false,
     sandbox: true,
     webSecurity: true,
     allowRunningInsecureContent: false,
     preload: path.join(__dirname, '../preload/index.js'),
   }
   ```
2. **Narrow Preload Surface**: The preload script exposes a single `window.interleafAPI` object. No raw `ipcRenderer` or Node.js globals are exposed.
3. **Zero Generic Shell/FS Channels**: IPC channels represent high-level business operations (`library.importDocument`, `annotations.create`, `agent.startSession`). No arbitrary `fs.readFile` or `exec` channels exist.
4. **Zod Validation**: All IPC payloads sent from the renderer are strictly validated with Zod schemas in the main process before execution.

## Consequences
- **Positive**: Strong privilege separation and current Electron hardening materially reduce renderer-compromise impact.
- **Positive**: Strict decoupling of UI components from main process filesystem and database logic.
- **Negative**: Requires maintaining explicit IPC message definitions and Zod schemas in `src/shared/`.
