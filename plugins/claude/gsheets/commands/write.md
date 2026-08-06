---
description: Write data to a Google Sheets range
argument-hint: <spreadsheet-id> <range> <values>
---

# /sheets:write

Write data to a Google Sheets spreadsheet.

## Usage

```
/sheets:write <spreadsheet-id> <range> <values>
```

Values can be comma-separated (single row) or JSON array (multiple rows).

## Examples

```
/sheets:write 1Bxi... Sheet1!A1 "Hello World"
/sheets:write 1Bxi... A1:C1 "Name,Email,Phone"
/sheets:write 1Bxi... A1:B2 [["Header1","Header2"],["Value1","Value2"]]
```

## What Happens

Calls `update_values`. Empty verified targets may apply directly; formulas and populated overwrites return a visual-review proposal. Report the returned status and never claim a pending proposal was written.
