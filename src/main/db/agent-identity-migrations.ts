/**
 * Durable agent-session target identity and authority snapshot (v24).
 *
 * `target_identity_json` records the exact canonical path plus the device and
 * inode proven when the session was created, so every later privileged
 * continuation (rehydrate, review, apply, open-folder, resume) can reject a
 * replaced, remounted, or symlink-swapped target instead of trusting the
 * current registry entry for the same handle.
 *
 * `authority_json` records the main-resolved effective permission policy,
 * profile fingerprint, resolved execution mode, exact native sandbox argv, and
 * the native-capability proof this session was started under. Resume enforces
 * this snapshot rather than the profile's current defaults, so a later profile
 * edit cannot widen an existing session's authority.
 *
 * Both columns are additive and main-only; neither is ever projected to the
 * renderer.
 *
 * The statement text is a checksum input and must never change.
 */
export const AGENT_SESSION_TARGET_AUTHORITY_STATEMENTS: readonly string[] = [
  `ALTER TABLE agent_sessions ADD COLUMN target_identity_json TEXT`,
  `ALTER TABLE agent_sessions ADD COLUMN authority_json TEXT`,
];

/**
 * Birth time joins the persisted file identity (v26; see
 * `src/main/security/file-identity.ts`).
 *
 * Device and inode are not an identity on Linux, which reuses inode numbers,
 * so every persisted identity now also records `birthtimeNs`. The identities
 * live in three JSON columns — working-directory capabilities, session target
 * identities, and custom-profile executable identities — and there is no
 * honest value to backfill: re-reading the birth time now would bless
 * whatever directory happens to sit at the path today, which is exactly the
 * replacement this field exists to detect.
 *
 * Each pre-existing identity therefore gains an explicit `"birthtimeNs": null`.
 * The rows stay readable (sessions remain listable, profiles remain listed),
 * and the readers treat `null` as an unprovable identity, so every privileged
 * continuation fails closed until the folder or executable is selected again,
 * which records a fresh, complete identity. Values that are not JSON objects
 * are left untouched for the readers to reject as malformed.
 */
export const FILE_IDENTITY_BIRTH_TIME_STATEMENTS: readonly string[] = [
  `UPDATE allowed_working_directories
      SET identity_json = json_set(identity_json, '$.birthtimeNs', NULL)
    WHERE json_valid(identity_json)
      AND json_type(identity_json) = 'object'
      AND json_type(identity_json, '$.birthtimeNs') IS NULL`,
  `UPDATE agent_sessions
      SET target_identity_json = json_set(target_identity_json, '$.birthtimeNs', NULL)
    WHERE target_identity_json IS NOT NULL
      AND json_valid(target_identity_json)
      AND json_type(target_identity_json) = 'object'
      AND json_type(target_identity_json, '$.birthtimeNs') IS NULL`,
  `UPDATE agent_profiles
      SET executable_identity_json = json_set(executable_identity_json, '$.birthtimeNs', NULL)
    WHERE executable_identity_json IS NOT NULL
      AND json_valid(executable_identity_json)
      AND json_type(executable_identity_json) = 'object'
      AND json_type(executable_identity_json, '$.birthtimeNs') IS NULL`,
];
