# 0.2.0 completion audit

| Release requirement | Automated evidence |
| --- | --- |
| Normalized registry and category filtering | registry, category, server discovery, and built smoke tests |
| Desktop OAuth with full Drive plus Sheets | OAuth, setup, runtime, and gateway tests |
| Owned selected My Drive boundary | setup display, persisted-selection sanitation, folder ancestry, and spreadsheet authorization tests |
| Risk review, app-only approval, verification, audit, and refresh | classifier, proposal, workflow, runtime, storage, and UI tests |
| Exact sign-out and batch-delete previews | runtime and gateway proposal tests |
| Default, every category, `all`, and read-only built discovery | `npm run smoke:built` |
| Every registered schema invocation | `npm run smoke:built` invokes all 63 built operations without credentials |
| Plugin package schema | plugin-creator validator |
| Gated disposable School Records lifecycle | non-secret integration contract plus `npm run integration:live` |

The credentialed live acceptance run is intentionally separate from CI. Its exact prerequisites and command are in the README. A release report must say whether that command actually ran; successful unit, smoke, or dry-run validation is not evidence of a Google account run.
