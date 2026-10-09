import { Leaf, FileText, Bot, Cpu } from 'lucide-react';
import { StatusDot } from './Badge.jsx';

export default function Header({ backend, useLlm, setUseLlm, currency, setCurrency, canReport, onReport }) {
  const llmReady = backend.info?.llm?.configured;
  const state = backend.state;
  return (
    <header className="sticky top-0 z-30 border-b border-white/[0.06] bg-ink-950/80 backdrop-blur-xl">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-3 px-4 py-3 lg:px-6">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-emerald-400 to-teal-600 shadow-glow">
            <Leaf className="text-ink-950" size={22} strokeWidth={2.5} />
          </div>
          <div>
            <h1 className="text-lg font-extrabold tracking-tight text-white">
              GreenCode <span className="text-emerald-400">AI</span>
            </h1>
            <p className="text-[11px] text-slate-500">Carbon-aware code optimization · 5-agent pipeline</p>
          </div>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div
            className="chip border-white/10 bg-white/[0.03] text-slate-300"
            title={backend.error || `Backend v${backend.info?.version || '?'} · Python ${backend.info?.runtimes?.python || '?'} · Node ${backend.info?.runtimes?.node || 'n/a'} · SQLite ${backend.info?.runtimes?.sqlite || '?'}`}
          >
            <StatusDot state={state} />
            {state === 'online' ? 'Backend online' : state === 'checking' ? 'Connecting…' : 'Backend offline'}
          </div>

          <button
            type="button"
            onClick={() => setUseLlm(!useLlm)}
            className={`chip ${
              useLlm && llmReady
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                : 'border-white/10 bg-white/[0.03] text-slate-300'
            }`}
            title={
              llmReady
                ? 'Toggle the Groq LLaMA-3.3-70B refactorer (falls back to the rule engine on failure)'
                : 'GROQ_API_KEY is not set on the backend - the offline AST rule engine is used'
            }
          >
            {useLlm && llmReady ? <Bot size={13} /> : <Cpu size={13} />}
            {useLlm && llmReady ? `Groq · ${backend.info.llm.model}` : useLlm ? 'Offline rule engine (no key)' : 'Offline rule engine'}
          </button>

          <div className="flex rounded-full border border-white/10 bg-white/[0.03] p-0.5" role="group" aria-label="Currency">
            {['INR', 'USD'].map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCurrency(c)}
                className={`rounded-full px-2.5 py-0.5 text-xs font-bold transition ${
                  currency === c ? 'bg-emerald-500 text-ink-950' : 'text-slate-400 hover:text-white'
                }`}
              >
                {c === 'INR' ? '₹' : '$'}
              </button>
            ))}
          </div>

          <button type="button" className="btn-primary py-1.5" disabled={!canReport} onClick={onReport}>
            <FileText size={15} /> Audit Report
          </button>
        </div>
      </div>
    </header>
  );
}
