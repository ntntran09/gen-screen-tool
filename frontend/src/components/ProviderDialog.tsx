import { copyText } from '../lib/clipboard';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, ApiError, type AuthStatus, type ProviderTestResult } from '../lib/api';
import { Button } from './fields';
import { MunLoader } from './MunLoader';

const STATE_LABEL: Record<AuthStatus['state'], string> = {
  not_connected: 'Not connected',
  connecting: 'Waiting for sign-in…',
  connected: 'Connected',
  expired: 'Session expired',
  permission_error: 'Permission error',
  provider_unavailable: 'Unavailable',
};

const POLL_MS = 2000;

export function ProviderDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmQuota, setConfirmQuota] = useState(false);
  const [testResult, setTestResult] = useState<ProviderTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api.authStatus();
      setStatus((prev) => {
        if (prev && prev.state !== s.state) onChanged();
        return s;
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }, [onChanged]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll only while the device-code login is waiting for the user.
  useEffect(() => {
    if (status?.state !== 'connecting') return;
    const t = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(t);
  }, [status?.state, refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    dialogRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const run = async (fn: () => Promise<AuthStatus | void>) => {
    setBusy(true);
    setError(null);
    try {
      const s = await fn();
      if (s) setStatus(s);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    setBusy(true);
    setTesting(true);
    setError(null);
    setTestResult(null);
    try {
      setTestResult(await api.testProvider('codex', { confirm_quota_use: true }));
      onChanged();
    } catch (e) {
      const err = e as ApiError;
      setError(`${err.code ? `${err.code}: ` : ''}${err.message}`);
      void refresh();
    } finally {
      setBusy(false);
      setTesting(false);
    }
  };

  const state = status?.state;
  const shownError = error ?? status?.error ?? null;

  // Portal to <body> so the dialog doesn't inherit toolbar layout (nowrap, overflow clipping).
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-dialog-title"
        className="max-h-full w-full max-w-md overflow-y-auto rounded-2xl border-2 border-outline bg-panel outline-none"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-line px-5 py-4">
          <div>
            <h2 id="provider-dialog-title" className="text-[15px] font-semibold">
              ChatGPT / Codex
            </h2>
            <p className="mt-0.5 text-[12px] text-ink-3">
              Sign in with your ChatGPT account. <span className="font-semibold text-warning">Experimental</span>: uses an
              undocumented OpenAI endpoint that may change or stop working.
            </p>
          </div>
          <button type="button" aria-label="Close" className="px-1 text-ink-3 hover:text-ink" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div className="flex items-center gap-2 text-[13px]">
            <span
              className={`size-2 rounded-full ${
                state === 'connected' ? 'bg-success' : state === 'connecting' ? 'bg-accent' : 'bg-ink-3'
              }`}
              aria-hidden
            />
            <span>{state ? STATE_LABEL[state] : 'Loading…'}</span>
          </div>

          {status && state === 'connected' && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg border border-line bg-panel-2 p-3 text-[12px]">
              <dt className="text-ink-3">Account</dt>
              <dd>{status.email ?? '—'}</dd>
              <dt className="text-ink-3">Plan</dt>
              <dd>{status.plan ?? 'unknown'}</dd>
              <dt className="text-ink-3">Workspace</dt>
              <dd className="font-mono">{status.account_id ?? '—'}</dd>
              <dt className="text-ink-3">Signed in via</dt>
              <dd>{status.source === 'codex-cli' ? 'Codex CLI login (imported)' : 'Device code'}</dd>
            </dl>
          )}

          {status?.pending && (
            <div className="space-y-3 rounded-xl border-2 border-accent/50 bg-accent-soft p-4">
              <p className="text-[12px] text-ink-2">
                1. Open the OpenAI page below and sign in.
                <br />
                2. Enter this code:
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded-lg border-2 border-outline bg-node px-3 py-2 text-center font-mono text-[20px] tracking-[0.2em] text-ink">
                  {status.pending.user_code}
                </code>
                <Button onClick={() => void copyText(status.pending!.user_code)}>Copy</Button>
              </div>
              <a
                href={status.pending.verification_url}
                target="_blank"
                rel="noopener noreferrer"
                className="block rounded-lg border-2 border-outline bg-accent py-2 text-center text-[13px] font-semibold text-accent-ink hover:bg-accent-hover"
              >
                Open {new URL(status.pending.verification_url).host}
              </a>
              <p className="text-[11px] text-ink-3">This window updates automatically once you approve. The code expires in 15 minutes.</p>
              <Button onClick={() => void run(() => api.cancelLogin())} disabled={busy}>
                Cancel
              </Button>
            </div>
          )}

          {shownError && (
            <p role="alert" className="rounded-lg border border-danger/40 bg-danger-soft px-3 py-2 text-[12px] text-danger">
              {shownError}
            </p>
          )}

          {status && (state === 'not_connected' || state === 'expired') && !status.pending && (
            <div className="space-y-3">
              <Button variant="primary" onClick={() => void run(() => api.connect('device_code'))} disabled={busy}>
                Sign in with ChatGPT
              </Button>
              {status.codex_cli_login_found && (
                <div className="rounded-lg border border-line p-3">
                  <p className="text-[12px] text-ink-2">A Codex CLI login was found on this computer.</p>
                  <p className="mt-1 text-[11px] text-ink-3">
                    Importing shares one session with the Codex CLI. If either app refreshes the token, the other may
                    be signed out. Signing in separately is more reliable.
                  </p>
                  <div className="mt-2">
                    <Button onClick={() => void run(() => api.connect('import_codex_cli'))} disabled={busy}>
                      Use Codex CLI login
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {state === 'connected' && (
            <div className="space-y-3 border-t border-line pt-4">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Test image generation</h3>
              <label className="flex items-start gap-2 text-[12px] text-ink-2">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-[var(--color-accent)]"
                  checked={confirmQuota}
                  onChange={(e) => setConfirmQuota(e.target.checked)}
                />
                I understand this generates one real image and uses my ChatGPT usage limits.
              </label>
              <div className="flex gap-2">
                <Button variant="primary" onClick={() => void runTest()} disabled={busy || !confirmQuota}>
                  {busy ? 'Generating…' : 'Generate test image'}
                </Button>
                <Button variant="danger" onClick={() => void run(() => api.disconnect())} disabled={busy}>
                  Disconnect
                </Button>
              </div>
              {testing && <MunLoader label="Mun is painting your test image…" />}
              {testResult && (
                <div className="flex gap-3 rounded-lg border border-line bg-panel-2 p-3">
                  <img src={testResult.preview} alt="Test result" className="size-24 rounded-md object-contain" />
                  <dl className="grid grid-cols-[auto_1fr] content-start gap-x-3 gap-y-0.5 text-[11px]">
                    <dt className="text-ink-3">Actual size</dt>
                    <dd>
                      {testResult.actual.width}×{testResult.actual.height}
                    </dd>
                    <dt className="text-ink-3">Format</dt>
                    <dd>{testResult.actual.mime_type}</dd>
                    <dt className="text-ink-3">Model</dt>
                    <dd>{testResult.reported_model ?? 'not reported'}</dd>
                    <dt className="text-ink-3">Time</dt>
                    <dd>{testResult.elapsed_seconds}s</dd>
                  </dl>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
