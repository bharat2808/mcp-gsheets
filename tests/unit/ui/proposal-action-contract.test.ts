import { describe, expect, it } from 'vitest';

import {
  PROPOSAL_ACTION_TOOLS,
  proposalActionSuccessMessage,
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
    expect(proposalActionSuccessMessage('approve_change', false)).toBe(
      'Google accepted the write, but verification differed. Refresh before another action.'
    );
    expect(proposalActionSuccessMessage('approve_change', true)).toBe('Change applied and verified.');
    expect(proposalActionSuccessMessage('edit_change')).toBe('Proposal updated.');
  });
});
