# Editable Table Approval UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render reviewed single and batch value edits as directly editable worksheet tables, with a four-minute server-enforced lifetime and permanently disabled controls after expiration or consumption.

**Architecture:** Keep normalized execution arguments and previews authoritative, and add a typed `presentation` object to proposals for spreadsheet/worksheet/range labels and table sections. Extend `ProposalManager` with a retained `expired` terminal state and four-minute lifetime, then move UI transformation and editing into pure helpers so behavior is unit-testable without mounting the Codex app bridge.

**Tech Stack:** TypeScript, React 19, MCP Apps SDK, Vitest, Google Sheets gateway, Vite single-file UI, Codex plugin CLI.

## Global Constraints

- Approval expires exactly four minutes after server-side proposal creation.
- A proposal may be edited, confirmed, approved, or cancelled only while pending and unexpired.
- Applied, verification-pending, cancelled, and expired proposals remain visible and permanently read-only.
- Single edits show one table; batch edits show one separately labeled table per worksheet/range in request order.
- Spreadsheet name appears once at the top; every table shows worksheet name and A1 range.
- Editable cells replace the JSON textarea; exact structural/destructive previews remain read-only JSON.
- Saving edits replaces the complete proposed values, rotates the nonce, and resets confirmation.
- Existing tool names and proposal version `2` remain unchanged.
- Use test-driven development for every behavior change.

---

### Task 1: Four-Minute, One-Time Proposal Lifecycle

**Files:**
- Modify: `src/proposals/proposal-manager.ts`
- Modify: `tests/unit/proposals/proposal-manager.test.ts`

**Interfaces:**
- Produces: `ProposalStatus` including `'expired'`.
- Produces: `ProposalManager.review(id)` returning retained terminal proposals, including expired proposals.
- Preserves: `edit`, `recordVisualConfirmation`, `approve`, and `cancel` accept only pending, unexpired proposals.

- [ ] **Step 1: Write failing lifetime tests**

Replace the fifteen-minute test with exact four-minute boundary coverage:

```ts
it('expires proposals after exactly four minutes and retains the terminal state', () => {
  let now = Date.parse('2026-08-12T00:00:00.000Z');
  const manager = new ProposalManager(gateway, () => now);
  const proposal = manager.prepare(baseRequest);
  expect(proposal.expiresAt).toBe('2026-08-12T00:04:00.000Z');
  now += 4 * 60 * 1000;
  expect(manager.review(proposal.id)).toMatchObject({ status: 'expired' });
  expect(manager.review(proposal.id)).toMatchObject({ status: 'expired' });
});
```

Add one test that calls `edit`, `recordVisualConfirmation`, `approve`, and `cancel` on expired/applied/cancelled proposals and asserts each rejects with `Proposal is expired`, `Proposal is applied`, or `Proposal is cancelled`; assert `gateway.apply` remains called once after an approval replay.

- [ ] **Step 2: Run the lifecycle test and verify RED**

Run: `npm test -- --run tests/unit/proposals/proposal-manager.test.ts`

Expected: FAIL because `expiresAt` is fifteen minutes, expiry deletes the proposal, and `expired` is not a status.

- [ ] **Step 3: Implement retained expiration and one-time enforcement**

Change the duration and terminal transition:

```ts
const FOUR_MINUTES = 4 * 60 * 1000;

#expireIfNeeded(proposal: ChangeProposal): void {
  if (proposal.status === 'pending' && this.#now() >= Date.parse(proposal.expiresAt)) {
    proposal.status = 'expired';
    proposal.visuallyConfirmed = false;
    proposal.nonce = '';
  }
}
```

Call `#expireIfNeeded` from `#required`, set `expiresAt` with `FOUR_MINUTES`, keep expired proposals in the bounded map, and let `#assertUsable` reject every terminal state. Update pruning to prefer terminal entries without deleting a proposal merely because its deadline passed.

- [ ] **Step 4: Run the lifecycle test and verify GREEN**

Run: `npm test -- --run tests/unit/proposals/proposal-manager.test.ts`

Expected: all proposal-manager tests pass.

- [ ] **Step 5: Commit lifecycle behavior**

```bash
git add src/proposals/proposal-manager.ts tests/unit/proposals/proposal-manager.test.ts
git commit -m "feat: enforce four-minute one-time approvals"
```

### Task 2: Typed Spreadsheet and Worksheet Presentation Contract

**Files:**
- Modify: `src/proposals/proposal-manager.ts`
- Modify: `src/operations/change-workflow.ts`
- Modify: `src/google/google-api-client.ts`
- Modify: `src/runtime/gsheets-runtime.ts`
- Modify: `tests/unit/google/google-sheets-gateway.test.ts`
- Modify: `tests/unit/operations/change-workflow.test.ts`
- Modify: `tests/unit/runtime/gsheets-runtime.test.ts`

**Interfaces:**
- Produces:

```ts
interface ValuePresentationSection {
  worksheetName: string;
  range: string;
  before: unknown[][] | Record<string, CellValue> | null;
  after: unknown[][] | Record<string, CellValue>;
}

interface ProposalPresentationData {
  spreadsheetName: string;
  valueSections: ValuePresentationSection[];
}
```

- Adds optional `presentation?: ProposalPresentationData` to `ChangeRequest` and `ChangeProposal`.
- `OperationPreflight` carries the same optional presentation data into proposal creation.

- [ ] **Step 1: Write failing single and batch presentation tests**

In the gateway test, return metadata with `properties.title: 'School Records'` and sheet titles. Assert:

```ts
expect(preflight.presentation).toEqual({
  spreadsheetName: 'School Records',
  valueSections: [
    {
      worksheetName: 'Students',
      range: 'Students!A2:B3',
      before: [['S001', 'Asha']],
      after: [['S001', 'Asha Sharma']],
    },
  ],
});
```

Add `batch_update_values` coverage with `Students!A2:B3` followed by `Exams!A2:B3`, asserting two sections remain in request order. Add a row-change runtime assertion for spreadsheet name `School Records` and worksheet `Students`.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- --run tests/unit/google/google-sheets-gateway.test.ts tests/unit/operations/change-workflow.test.ts tests/unit/runtime/gsheets-runtime.test.ts`

Expected: FAIL because proposals have no `presentation` object and generic resources use IDs as labels.

- [ ] **Step 3: Build presentation data during preflight**

For reviewed value operations, fetch metadata alongside ranges and create presentation sections using a range helper that extracts the worksheet name from A1 notation. Preserve batch request order by zipping normalized ranges, preflight value ranges, and requested `data` entries.

For row proposals, construct:

```ts
presentation: {
  spreadsheetName: details.spreadsheet.name,
  valueSections: [{
    worksheetName: sheet.title,
    range: input.rowNumber ? `${sheet.title}!${input.rowNumber}:${input.rowNumber}` : sheet.title,
    before: displayBeforeValues ?? expectedValues ?? null,
    after: input.values,
  }],
}
```

Thread `preflight.presentation` through `ChangeWorkflow.execute()` into `ProposalManager.prepare()` without using presentation labels for execution.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm test -- --run tests/unit/google/google-sheets-gateway.test.ts tests/unit/operations/change-workflow.test.ts tests/unit/runtime/gsheets-runtime.test.ts`

Expected: focused tests pass and batch section order is stable.

- [ ] **Step 5: Commit presentation contract**

```bash
git add src/proposals/proposal-manager.ts src/operations/change-workflow.ts src/google/google-api-client.ts src/runtime/gsheets-runtime.ts tests/unit/google/google-sheets-gateway.test.ts tests/unit/operations/change-workflow.test.ts tests/unit/runtime/gsheets-runtime.test.ts
git commit -m "feat: describe reviewed spreadsheet table sections"
```

### Task 3: Complete Batch Table Editing Contract

**Files:**
- Create: `ui/src/proposal-table-model.ts`
- Create: `tests/unit/ui/proposal-table-model.test.ts`
- Modify: `ui/src/proposal-action-contract.ts`
- Modify: `tests/unit/ui/proposal-action-contract.test.ts`
- Modify: `src/proposals/proposal-manager.ts`
- Modify: `tests/unit/proposals/proposal-manager.test.ts`

**Interfaces:**
- Produces `proposalTableModel(proposal): EditableTableSection[]`.
- Produces `updateTableCell(sections, sectionIndex, rowIndex, columnIndex, value)` as an immutable update.
- Produces `editableValuesForOperation(operation, sections)` returning `values` for single writes, ordered `{range, values}[]` for batch writes, and keyed values for row proposals.

- [ ] **Step 1: Write failing pure-model tests**

Cover rectangular padding, worksheet/range labels, immutable cell updates, and batch serialization:

```ts
expect(editableValuesForOperation('batch_update_values', sections)).toEqual([
  { range: 'Students!A2:B3', values: [['S001', 'Asha']] },
  { range: 'Exams!A2:B3', values: [['S001', 95]] },
]);
```

Assert editing section two never changes section one. Update action-contract tests to reject table edits for exact previews and terminal proposals.

- [ ] **Step 2: Run UI contract tests and verify RED**

Run: `npm test -- --run tests/unit/ui/proposal-table-model.test.ts tests/unit/ui/proposal-action-contract.test.ts tests/unit/proposals/proposal-manager.test.ts`

Expected: FAIL because the table model does not exist and `edit_change` does not understand section output.

- [ ] **Step 3: Implement pure table transformations and server mapping**

Create focused helpers with no React dependencies. Change `ProposalManager.edit()` so `batch_update_values` replaces `arguments.data` with the complete ordered array and refreshes `presentation.valueSections[].after`; single updates replace `arguments.values`; row changes replace their keyed values. Validate section counts/ranges before mutation, then rotate the nonce only after validation succeeds.

- [ ] **Step 4: Run UI contract tests and verify GREEN**

Run: `npm test -- --run tests/unit/ui/proposal-table-model.test.ts tests/unit/ui/proposal-action-contract.test.ts tests/unit/proposals/proposal-manager.test.ts`

Expected: all focused table/edit tests pass.

- [ ] **Step 5: Commit table model**

```bash
git add ui/src/proposal-table-model.ts tests/unit/ui/proposal-table-model.test.ts ui/src/proposal-action-contract.ts tests/unit/ui/proposal-action-contract.test.ts src/proposals/proposal-manager.ts tests/unit/proposals/proposal-manager.test.ts
git commit -m "feat: support complete editable batch tables"
```

### Task 4: Render Editable Tables and Terminal Modal States

**Files:**
- Modify: `ui/src/main.tsx`
- Modify: `ui/src/styles.css`
- Modify: `ui/src/proposal-action-contract.ts`
- Modify: `tests/unit/ui/proposal-action-contract.test.ts`

**Interfaces:**
- Consumes: `proposalTableModel`, `updateTableCell`, and `editableValuesForOperation` from Task 3.
- Produces: `proposalUiState(status, expiresAt, now)` returning `{ statusLabel, terminal, remainingMs }`.

- [ ] **Step 1: Write failing presentation-state tests**

Assert pending countdown, exact expiry, and every terminal state:

```ts
expect(proposalUiState('pending', '2026-08-12T00:04:00Z', Date.parse('2026-08-12T00:00:30Z')))
  .toEqual({ statusLabel: 'Pending', terminal: false, remainingMs: 210000 });
expect(proposalUiState('pending', '2026-08-12T00:04:00Z', Date.parse('2026-08-12T00:04:00Z')))
  .toEqual({ statusLabel: 'Expired', terminal: true, remainingMs: 0 });
```

Add assertions for `Applied`, `Applied — verification pending`, and `Cancelled` with `terminal: true`.

- [ ] **Step 2: Run presentation-state tests and verify RED**

Run: `npm test -- --run tests/unit/ui/proposal-action-contract.test.ts`

Expected: FAIL because terminal/countdown helpers do not exist.

- [ ] **Step 3: Implement the table modal**

Replace `draft: string` with `tableSections`. Use a one-second interval for display-only countdown updates. Render spreadsheet name once, then map sections to `<table>` elements whose `after` cells are controlled `<input>` elements. Disable inputs, checkbox, save, cancel, and apply when `proposalUiState(...).terminal` is true. Keep exact previews in the existing `<pre>` layout.

Render the Save edits button using:

```ts
const values = editableValuesForOperation(proposal.operation, tableSections);
void call(PROPOSAL_ACTION_TOOLS.edit, { proposalId: proposal.id, values });
```

On any cell edit, clear confirmation. After any proposal response, rebuild table sections from the returned proposal and clear confirmation through the existing security helper.

- [ ] **Step 4: Style responsive tables and terminal states**

Add horizontally scrollable `.table-section`, `.value-table`, `.before-cell`, `.after-cell`, `.countdown`, and `.status.expired` styles. Preserve keyboard focus indicators and native input semantics. On narrow screens, keep the table scrollable instead of collapsing cells into ambiguous cards.

- [ ] **Step 5: Run UI tests and build**

Run: `npm test -- --run tests/unit/ui/proposal-action-contract.test.ts tests/unit/ui/proposal-table-model.test.ts && npm run build`

Expected: tests pass and Vite produces `dist/ui/index.html` without TypeScript or bundling errors.

- [ ] **Step 6: Commit the confirmation modal**

```bash
git add ui/src/main.tsx ui/src/styles.css ui/src/proposal-action-contract.ts tests/unit/ui/proposal-action-contract.test.ts
git commit -m "feat: render editable approval tables"
```

### Task 5: MCP Modal Coverage and Migration Safety

**Files:**
- Modify: `tests/unit/server/tool-surface.test.ts`
- Modify: `tests/unit/plugin/tool-registry.test.ts`
- Modify: `tests/unit/storage/local-index.test.ts`
- Modify: `src/storage/local-index.ts` only if persisted proposal migration requires normalization.

**Interfaces:**
- Preserves: reviewed `update_values` and `batch_update_values` return the review UI resource metadata and app-only confirmation token.
- Preserves: old persisted proposals cannot become pending/consumable after upgrade.

- [ ] **Step 1: Write failing MCP and migration tests**

Add a tool-surface test that makes populated single and batch writes and asserts both responses contain `ui://gsheets/review.html`, `version: 2`, presentation labels, and confirmation metadata. Add a storage migration fixture missing `presentation` and assert it is either normalized as terminal `expired` or excluded from pending review.

- [ ] **Step 2: Run focused integration tests and verify RED**

Run: `npm test -- --run tests/unit/server/tool-surface.test.ts tests/unit/plugin/tool-registry.test.ts tests/unit/storage/local-index.test.ts`

Expected: FAIL on the new batch modal/presentation or migration assertions.

- [ ] **Step 3: Implement minimal metadata or migration adjustments**

Keep the existing review resource URI on every reviewed mutation. If proposals are persisted, normalize records without presentation fields to `{ status: 'expired', nonce: '', visuallyConfirmed: false }`; do not synthesize a pending token. Avoid schema/version changes unless the storage tests show they are required.

- [ ] **Step 4: Run focused integration tests and verify GREEN**

Run: `npm test -- --run tests/unit/server/tool-surface.test.ts tests/unit/plugin/tool-registry.test.ts tests/unit/storage/local-index.test.ts`

Expected: single and batch reviewed writes expose the same modal contract and old data is non-consumable.

- [ ] **Step 5: Commit integration coverage**

```bash
git add tests/unit/server/tool-surface.test.ts tests/unit/plugin/tool-registry.test.ts tests/unit/storage/local-index.test.ts src/storage/local-index.ts
git commit -m "test: cover approval modal and proposal migration"
```

### Task 6: Full Verification, Cachebuster, and Reinstall

**Files:**
- Modify via helper: `.codex-plugin/plugin.json`

**Interfaces:**
- Produces: a cache-busted `0.2.0+codex.<UTC timestamp>` installed from the existing `gsheets-local` marketplace.

- [ ] **Step 1: Run the complete repository gate**

Run: `npm run check:all`

Expected: typecheck, lint, formatting, all Vitest files, server build, and UI build pass.

- [ ] **Step 2: Validate the plugin and built MCP surface**

Run:

```bash
uv run --with pyyaml python /Users/home/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .
npm run smoke:built
```

Expected: plugin validation passes and all 63 operations pass category/read-only/schema smoke tests.

- [ ] **Step 3: Update the cachebuster through the plugin helper**

Run:

```bash
python3 /Users/home/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py /Users/home/antigravity/mcp-gsheets-bharat2808
```

Expected: only the existing `+codex.` suffix changes.

- [ ] **Step 4: Rebuild and reinstall from the confirmed local marketplace**

Run:

```bash
npm run build
codex plugin add gsheets@gsheets-local
codex plugin list
```

Expected: `gsheets@gsheets-local` is installed and enabled at the new cache-busted version.

- [ ] **Step 5: Run installed-artifact MCP checks**

Start the installed `dist/index.js` with `GSHEETS_TOOL_CATEGORIES=all`. Prepare one populated `update_values` proposal and one populated `batch_update_values` proposal against a disposable workbook. Verify both return the review UI, spreadsheet/worksheet labels, four-minute expiry, and distinct table sections. Approve at most one disposable non-destructive value proposal through the app; replay its approval token and verify the server rejects it without applying a second write. Let another proposal expire and verify its modal remains read-only.

- [ ] **Step 6: Commit the cachebuster after fresh evidence**

```bash
git add .codex-plugin/plugin.json
git commit -m "chore: reinstall editable approval tables"
```

Do not claim completion unless the working tree is clean and the installed version matches `.codex-plugin/plugin.json`.
