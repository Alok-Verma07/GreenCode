import { FileText } from 'lucide-react';
import { StatusDot } from './Badge.jsx';

function Logo() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="0.5" y="0.5" width="23" height="23" rx="6" fill="#18181B" stroke="#3F3F46" />
      <path d="M7 16.5c0-5 3.5-8.5 10-9-.4 6.4-3.9 10-9 10" fill="none" stroke="#10B981" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7 17.5 12 12.5" stroke="#10B981" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

const STATUS_TEXT = { online: 'Backend Online', checking: 'Connecting', offline: 'Backend Offline' };

export default function Header({ backend, port, project, useLlm, setUseLlm, currency, setCurrency, canReport, onReport }) {
  const llmReady = !!backend.info?.llm?.configured;
  const engine = useLlm && llmReady ? 'llm' : 'rules';
  const runtimeTip =
    backend.error ||
    `v${backend.info?.version || '?'} · Python ${backend.info?.runtimes?.python || '?'} · Node ${backend.info?.runtimes?.node || 'n/a'} · SQLite ${backend.info?.runtimes?.sqlite || '?'}`;

  return (
    <header className="sticky top-0 z-30 h-14 border-b border-line bg-canvas/85 backdrop-blur-md">
      <div className="mx-auto flex h-full max-w-[1440px] items-center gap-3 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <Logo />
          <span className="text-[14px] font-semibold tracking-tight text-zinc-100">GreenCode</span>
          <span className="hidden text-zinc-700 md:inline">/</span>
          <span className="hidden truncate text-[13px] text-zinc-400 md:inline">{project}</span>
        </div>

        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          <div className="flex items-center gap-2 font-mono text-[11px] text-zinc-400" title={runtimeTip}>
            <StatusDot state={backend.state} />
            <span className="hidden sm:inline">{STATUS_TEXT[backend.state]}</span>
            <span className="hidden text-zinc-600 sm:inline">•</span>
            <span className="hidden sm:inline">Port {port}</span>
          </div>

          <span className="hidden h-4 w-px bg-line lg:block" />

          <div className="seg-group hidden lg:inline-flex" role="group" aria-label="Refactor engine">
            <button
              type="button"
              className={`seg ${engine === 'llm' ? 'seg-active' : ''}`}
              disabled={!llmReady}
              onClick={() => setUseLlm(true)}
              title={llmReady ? `Groq ${backend.info.llm.model} (falls back to the rule engine on failure)` : 'Set GROQ_API_KEY in backend/.env to enable'}
            >
              Groq LLaMA
            </button>
            <button
              type="button"
              className={`seg ${engine === 'rules' ? 'seg-active' : ''}`}
              onClick={() => setUseLlm(false)}
              title="Deterministic offline AST rule engine"
            >
              Rule engine
            </button>
          </div>

          <div className="seg-group" role="group" aria-label="Currency">
            {['INR', 'USD'].map((c) => (
              <button key={c} type="button" onClick={() => setCurrency(c)} className={`seg w-8 justify-center px-0 ${currency === c ? 'seg-active' : ''}`}>
                {c === 'INR' ? '₹' : '$'}
              </button>
            ))}
          </div>

          <button type="button" className="btn-primary" disabled={!canReport} onClick={onReport}>
            <FileText size={14} />
            <span className="hidden sm:inline">Audit Report</span>
          </button>
        </div>
      </div>
    </header>
  );
}
