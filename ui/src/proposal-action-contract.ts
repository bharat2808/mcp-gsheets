export const PROPOSAL_ACTION_TOOLS = {
  cancel: 'cancel_change',
  edit: 'edit_change',
  approve: 'approve_change',
} as const;

export interface ProposalSecurityState {
  confirmed: boolean;
  confirmationToken: string;
}

export function proposalSecurityStateAfterResponse(
  _state: ProposalSecurityState,
  confirmationToken: unknown
): ProposalSecurityState {
  return {
    confirmed: false,
    confirmationToken: typeof confirmationToken === 'string' ? confirmationToken : '',
  };
}

export function proposalSecurityStateBeforeAction(
  state: ProposalSecurityState,
  action: string
): ProposalSecurityState {
  return action === PROPOSAL_ACTION_TOOLS.edit
    ? { confirmed: false, confirmationToken: '' }
    : state;
}

export function proposalActionSuccessMessage(
  name: string,
  verificationState?: 'not_started' | 'verified' | 'applied_verification_pending'
): string {
  if (name !== PROPOSAL_ACTION_TOOLS.approve) {
    return 'Proposal updated.';
  }
  return verificationState === 'applied_verification_pending'
    ? 'Change applied, but verification is pending. Refresh before dependent destructive work.'
    : 'Change applied and verified.';
}

export function proposalPresentation(proposal: {
  operation: string;
  editable: boolean;
  preview: { kind: 'values' | 'exact' };
}) {
  const title = proposal.operation.replaceAll('_', ' ');
  return {
    title: title[0]?.toUpperCase() + title.slice(1),
    editable: proposal.editable && proposal.preview.kind === 'values',
    previewKind: proposal.preview.kind,
  } as const;
}

export function parseEditableProposalValues(
  draft: string,
  previewKind: 'values' | 'exact'
): unknown {
  if (previewKind !== 'values') throw new Error('This exact proposal is not editable.');
  try {
    return JSON.parse(draft) as unknown;
  } catch {
    throw new Error('Proposed values must be valid JSON.');
  }
}
