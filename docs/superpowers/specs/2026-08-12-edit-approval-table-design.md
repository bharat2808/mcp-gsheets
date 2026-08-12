# Editable Table Approval UI Design

## Goal

Make reviewed Google Sheets value changes understandable and editable without exposing raw JSON. The review UI must identify the spreadsheet and every affected worksheet, support batch changes in one confirmation modal, expire proposals after four minutes, and prevent every proposal from being consumed more than once.

## Proposal Contract

The public proposal payload remains versioned and gains presentation data sufficient for the UI to render value changes without guessing names from resource IDs:

- `spreadsheetName` identifies the Google Sheets file.
- Each value-change section identifies its `worksheetName`, A1 `range`, `before` grid, and `after` grid.
- A single-range edit contains one section.
- `batch_update_values` contains one section per requested range, preserving request order.
- Exact structural and destructive previews continue to use their existing read-only representation.

Spreadsheet and worksheet names are derived from the indexed spreadsheet metadata and Google preflight state. They are display metadata only; execution continues to use stable spreadsheet and sheet IDs plus the original normalized arguments.

## Confirmation Modal

The modal header shows the operation, proposal status, spreadsheet name, and remaining approval time. Each affected worksheet/range appears as a separately labeled section.

For editable value proposals, every `after` cell is a form control inside a table. The corresponding `before` values remain visible for comparison. Empty and missing cells are represented consistently, and rectangular grids are padded for display without silently adding data outside the proposed ranges.

Single edits render one table section. Batch edits render all worksheet/range sections in the same modal. There is one confirmation checkbox and one final approval action for the entire proposal, so a batch cannot be partially approved.

Saving table edits sends the complete edited value structure through `edit_change`. The server updates the normalized proposal arguments, rotates the nonce, clears prior visual confirmation, and returns the refreshed proposal. The user must review and confirm again before applying it.

Exact structural and destructive proposals remain non-editable. Their before/after JSON can remain visible because it represents operation structure rather than a cell grid.

## Four-Minute Lifetime

Proposals expire exactly four minutes after server-side creation. The server-generated `expiresAt` remains authoritative.

The UI displays a live countdown and changes a pending proposal to an `Expired` presentation when the deadline passes. At that point all table inputs, confirmation controls, save, cancel, and apply controls are disabled. A server response reporting expiration also transitions the modal into the expired presentation.

## One-Time Consumption

A proposal is consumable only while its server-side status is `pending` and it has not expired. Applying or cancelling it makes it terminal. Expiration also becomes a retained terminal state instead of deleting the proposal immediately.

The server rejects subsequent edit, confirmation, approval, or cancellation attempts for terminal proposals. It must not reissue a usable nonce after consumption. This enforcement applies even if a caller bypasses the UI or replays a previously issued confirmation token.

The modal remains visible after a terminal transition and shows one of these read-only badges:

- `Expired`
- `Applied`
- `Applied — verification pending`
- `Cancelled`

All editing and approval controls are disabled for every terminal state.

## Data Flow

1. Risk classification routes a value write to review.
2. Preflight captures current values, spreadsheet name, worksheet names, ranges, and revisions.
3. The proposal manager creates a four-minute, pending proposal with a one-time nonce.
4. The tool result opens the confirmation modal with the public proposal and app-only confirmation token.
5. Optional table edits call `edit_change`, replace the complete proposed values, rotate the nonce, and reset confirmation.
6. Approval validates pending status, expiry, nonce, revisions, and target state before executing the entire operation.
7. The proposal becomes terminal before another approval can consume it. The UI retains the terminal result with disabled controls.

## Error Handling

- Invalid edited grids are rejected without modifying the proposal or rotating its current nonce.
- An expired proposal returns its terminal public representation where possible, allowing the UI to show `Expired` rather than a generic failure.
- Replayed or stale confirmation tokens are rejected.
- Revision or target-state changes leave the proposal pending only when no Google mutation occurred; visual confirmation is reset and a fresh nonce is issued.
- If Google applied the mutation but verification is pending, the proposal is terminal and cannot be approved again.

## Testing

Automated tests will cover:

- Four-minute `expiresAt` calculation and the exact expiry boundary.
- Retained expired status and rejection of edit, confirm, approve, and cancel after expiry.
- Rejection of all repeated actions after applied, verification-pending, or cancelled states.
- Spreadsheet and worksheet names in single-range and batch proposal payloads.
- Batch section ordering and complete edited-value round trips.
- Direct cell editing, table rendering, countdown behavior, and disabled controls for every terminal status.
- Confirmation reset and nonce rotation after valid table edits.
- MCP tool metadata continuing to attach the confirmation modal to reviewed single and batch writes.
- Full unit, integration, type, lint, build, plugin validation, and built-MCP smoke checks before reinstalling the cache-busted plugin.

## Compatibility and Scope

This is an in-place `0.2.0` plugin update. Tool names do not change. Existing stored proposals may be migrated or treated as expired if they lack the new presentation fields; they must never regain consumability. The change applies to reviewed value edits and batch value edits. It does not make structural or destructive proposals editable.
