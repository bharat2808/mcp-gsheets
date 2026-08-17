import { describe, expect, it } from 'vitest';

import {
  PROPOSAL_ACTION_TOOLS,
  proposalPresentation,
  proposalActionSuccessMessage,
  parseEditableProposalValues,
  proposalSecurityStateAfterResponse,
  proposalSecurityStateBeforeAction,
  proposalUiState,
} from '../../../ui/src/proposal-action-contract.js';

describe('proposal review action contract', () => {
  it('calls the normalized app-only operation names', () => {
    expect(PROPOSAL_ACTION_TOOLS).toEqual({
      cancel: 'cancel_change',
      edit: 'edit_change',
      approve: 'approve_change',
    });
  });

  it('shows the approval result only for the normalized approval operation', () => {
    expect(proposalActionSuccessMessage('approve_change', 'applied_verification_pending')).toBe(
      'Change applied, but verification is pending. Refresh before dependent destructive work.'
    );
    expect(proposalActionSuccessMessage('approve_change', 'verified')).toBe(
      'Change applied and verified.'
    );
    expect(proposalActionSuccessMessage('edit_change')).toBe('Proposal updated.');
  });

  it('presents editable values and exact structural previews differently', () => {
    expect(
      proposalPresentation({
        operation: 'update_values',
        editable: true,
        preview: { kind: 'values', before: [['Open']], after: [['Paid']] },
      })
    ).toEqual({ title: 'Update values', editable: true, previewKind: 'values' });
    expect(
      proposalPresentation({
        operation: 'delete_rows',
        editable: false,
        preview: { kind: 'exact', before: { rows: [4] }, after: { rows: [] } },
      })
    ).toEqual({ title: 'Delete rows', editable: false, previewKind: 'exact' });
  });

  it('parses edited value previews but rejects edits to exact previews', () => {
    expect(parseEditableProposalValues('{"Status":"Paid"}', 'values')).toEqual({ Status: 'Paid' });
    expect(() => parseEditableProposalValues('{"rows":[]}', 'exact')).toThrow('not editable');
    expect(() => parseEditableProposalValues('not json', 'values')).toThrow('valid JSON');
  });

  it('clears confirmation for every proposal response and clears the old token before edit', () => {
    expect(
      proposalSecurityStateAfterResponse(
        { confirmed: true, confirmationToken: 'old-token' },
        'fresh-token'
      )
    ).toEqual({ confirmed: false, confirmationToken: 'fresh-token' });
    expect(
      proposalSecurityStateAfterResponse(
        { confirmed: true, confirmationToken: 'old-token' },
        undefined
      )
    ).toEqual({ confirmed: false, confirmationToken: '' });
    expect(
      proposalSecurityStateBeforeAction(
        { confirmed: true, confirmationToken: 'old-token' },
        'edit_change'
      )
    ).toEqual({ confirmed: false, confirmationToken: '' });
  });

  it('shows a live pending countdown and expires at the exact deadline', () => {
    expect(
      proposalUiState('pending', '2026-08-12T00:04:00.000Z', Date.parse('2026-08-12T00:00:30.000Z'))
    ).toEqual({ statusLabel: 'Pending', terminal: false, remainingMs: 210_000 });
    expect(
      proposalUiState('pending', '2026-08-12T00:04:00.000Z', Date.parse('2026-08-12T00:04:00.000Z'))
    ).toEqual({ statusLabel: 'Expired', terminal: true, remainingMs: 0 });
  });

  it('makes every consumed proposal state terminal', () => {
    expect(proposalUiState('expired', '2026-08-12T00:04:00.000Z', 0)).toMatchObject({
      statusLabel: 'Expired',
      terminal: true,
    });
    expect(proposalUiState('applied', '2026-08-12T00:04:00.000Z', 0)).toMatchObject({
      statusLabel: 'Applied',
      terminal: true,
    });
    expect(
      proposalUiState('applied_verification_pending', '2026-08-12T00:04:00.000Z', 0)
    ).toMatchObject({ statusLabel: 'Applied — verification pending', terminal: true });
    expect(proposalUiState('cancelled', '2026-08-12T00:04:00.000Z', 0)).toMatchObject({
      statusLabel: 'Cancelled',
      terminal: true,
    });
  });
});
