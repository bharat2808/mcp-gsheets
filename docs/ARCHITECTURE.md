# Architecture

The plugin is a local stdio MCP server with a localhost-only setup server and a single-file MCP App for visual review. One typed operation registry owns the normalized name, category, schema, annotations, visibility, and handler for every operation. `GSHEETS_TOOL_CATEGORIES` filters discovery and `GSHEETS_READ_ONLY=true` removes every mutation and proposal-management operation.

Desktop OAuth uses PKCE and a loopback redirect. Tokens, the OAuth client secret, and the 256-bit local data key are separate entries in the operating-system credential vault. The non-secret client ID may come from an environment override, user-only local config, or publisher fallback. The required scopes are full Drive and Sheets. An older token missing full Drive is left intact while status and setup request one-time re-consent.

Full Drive is the provider permission needed to discover pre-existing spreadsheets through a custom picker. The product authorization gate is narrower: folder candidates and persisted selections must be owned by the authenticated account, reach that account's My Drive root through owned folders, and be explicitly selected. Every spreadsheet operation verifies ownership, rejects Shared Drives, walks owned ancestry to the My Drive root, and requires a selected-folder ancestor. Setup sanitizes selections before display and connection sanitizes them before refresh.

`GoogleSheetsGateway` owns OAuth refresh, Sheets and Drive clients, authorization, normalized errors, revision reads, verification hooks, and retry policy. Only idempotent operations retry 429 or 5xx responses. Appends, approvals, destructive calls, create-like calls, and Drive parent changes are single-attempt.

The encrypted SQLite index stores catalog metadata, formatted and raw rows, native table metadata, detected changes, approved-write audits, and pending-verification blocks. Values and metadata are AES-256-GCM encrypted; row search uses HMAC blind tokens. Startup catches up the selected catalog, then polling checks Drive versions every five minutes.

All mutations enter one serialized `ChangeWorkflow`. Preflight captures exact resources, before/after state, Drive revisions, and risk inputs. Verified non-lossy work may apply directly. Risky work produces a versioned proposal whose confirmation token is visible only to the review app. Approval rechecks revisions and target state, applies once, verifies the result, records an encrypted audit, and refreshes the index. Post-application verification or refresh failure becomes `applied_verification_pending` and blocks overlapping destructive work.

Reviewed sign-out uses an account-specific exact preview. Approval optionally revokes the Google grant, deletes tokens, transactionally clears account-bound index state, and disconnects. Failure before completion keeps a coherent retry path.
