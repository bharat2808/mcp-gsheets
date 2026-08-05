import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  useApp,
  useDocumentTheme,
  useHostStyleVariables,
} from '@modelcontextprotocol/ext-apps/react';

import {
  parseEditableProposalValues,
  PROPOSAL_ACTION_TOOLS,
  proposalActionSuccessMessage,
  proposalPresentation,
} from './proposal-action-contract.js';
import './styles.css';

interface Proposal {
  version: 2;
  id: string;
  operation: string;
  arguments: Record<string, unknown>;
  affectedResources: Array<{ kind: string; id: string; label: string }>;
  preview: { kind: 'values' | 'exact'; before: unknown; after: unknown };
  riskReasons: string[];
  editable: boolean;
  status: 'pending' | 'applied' | 'applied_verification_pending' | 'cancelled';
  verificationState: 'not_started' | 'verified' | 'applied_verification_pending';
  expiresAt: string;
  result?: { data: unknown; verificationError?: string };
}

function proposalFrom(value: unknown): Proposal | null {
  if (!value || typeof value !== 'object') return null;
  const container = value as { data?: unknown };
  const candidate = (container.data ?? value) as Partial<Proposal>;
  return candidate.version === 2 && typeof candidate.id === 'string' && candidate.preview
    ? (candidate as Proposal)
    : null;
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? 'null';
}

function ReviewApp() {
  useHostStyleVariables();
  useDocumentTheme();
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [draft, setDraft] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [confirmationToken, setConfirmationToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const { app, isConnected, error } = useApp({
    appInfo: { name: 'GSheets review', version: '0.1.0' },
    capabilities: {},
    onAppCreated: (createdApp) => {
      createdApp.ontoolresult = (params) => {
        const next = proposalFrom(params.structuredContent);
        if (next) {
          setProposal(next);
          setDraft(pretty(next.preview.after));
          setConfirmed(false);
        }
        const token = params._meta?.['gsheets/confirmationToken'];
        if (typeof token === 'string') setConfirmationToken(token);
      };
    },
  });

  const expires = useMemo(
    () => (proposal ? new Date(proposal.expiresAt).toLocaleTimeString() : ''),
    [proposal]
  );
  const presentation = proposal ? proposalPresentation(proposal) : null;

  async function call(name: string, arguments_: Record<string, unknown>) {
    if (!app) return;
    setBusy(true);
    setMessage('');
    try {
      const response = await app.callServerTool({ name, arguments: arguments_ });
      if (response.isError) throw new Error('The server rejected this action.');
      const next = proposalFrom(response.structuredContent);
      if (next) {
        setProposal(next);
        setDraft(pretty(next.preview.after));
      }
      const token = response._meta?.['gsheets/confirmationToken'];
      if (typeof token === 'string') setConfirmationToken(token);
      setMessage(proposalActionSuccessMessage(name, next?.verificationState));
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  if (error)
    return (
      <main>
        <h1>Review unavailable</h1>
        <p>{error.message}</p>
      </main>
    );
  if (!isConnected)
    return (
      <main>
        <p>Connecting to GSheets…</p>
      </main>
    );
  if (!proposal || !presentation)
    return (
      <main>
        <h1>Review change</h1>
        <p>Waiting for a proposal…</p>
      </main>
    );

  return (
    <main>
      <header>
        <div>
          <span className="eyebrow">Google Sheets</span>
          <h1>{presentation.title}</h1>
        </div>
        <span className={`status ${proposal.status}`}>{proposal.status.replaceAll('_', ' ')}</span>
      </header>
      <p className="location">
        {proposal.affectedResources.map((resource) => resource.label).join(' → ')} · expires at{' '}
        {expires}
      </p>
      <section className="risks" aria-label="Why review is required">
        <h2>Why this needs review</h2>
        <ul>
          {proposal.riskReasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      </section>
      <section>
        <div className="preview-grid">
          <div>
            <h2>Before</h2>
            <pre>{pretty(proposal.preview.before)}</pre>
          </div>
          <div>
            <h2>After</h2>
            {presentation.editable ? (
              <textarea
                aria-label="Proposed values"
                value={draft}
                rows={12}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setConfirmed(false);
                }}
              />
            ) : (
              <pre>{pretty(proposal.preview.after)}</pre>
            )}
          </div>
        </div>
      </section>
      {proposal.status === 'pending' && (
        <>
          <label className="confirm">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />{' '}
            I reviewed the before and after state and want to apply this exact change.
          </label>
          <div className="actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => call(PROPOSAL_ACTION_TOOLS.cancel, { proposalId: proposal.id })}
            >
              Cancel
            </button>
            {presentation.editable && (
              <button
                className="secondary"
                disabled={busy}
                onClick={() => {
                  try {
                    const values = parseEditableProposalValues(draft, proposal.preview.kind);
                    void call(PROPOSAL_ACTION_TOOLS.edit, { proposalId: proposal.id, values });
                  } catch (caught) {
                    setMessage(caught instanceof Error ? caught.message : String(caught));
                  }
                }}
              >
                Save edits
              </button>
            )}
            <button
              disabled={busy || !confirmed || !confirmationToken}
              onClick={() =>
                call(PROPOSAL_ACTION_TOOLS.approve, { proposalId: proposal.id, confirmationToken })
              }
            >
              Apply change
            </button>
          </div>
        </>
      )}
      {proposal.verificationState === 'applied_verification_pending' && (
        <p className="message pending" role="alert">
          Applied, but verification is pending. Dependent destructive work is blocked until refresh
          succeeds.
          {proposal.result?.verificationError ? ` ${proposal.result.verificationError}` : ''}
        </p>
      )}
      {message && (
        <p className="message" role="status">
          {message}
        </p>
      )}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<ReviewApp />);
