export const PROPOSAL_ACTION_TOOLS = {
  cancel: 'cancel_change',
  edit: 'edit_change',
  approve: 'approve_change',
} as const;

export function proposalActionSuccessMessage(
  name: string,
  verified?: boolean
): string {
  if (name !== PROPOSAL_ACTION_TOOLS.approve) {
    return 'Proposal updated.';
  }
  return verified === false
    ? 'Google accepted the write, but verification differed. Refresh before another action.'
    : 'Change applied and verified.';
}
