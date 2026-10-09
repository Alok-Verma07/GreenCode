import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Play, Square, Braces, Database, FileCode2, Undo2, AlertTriangle } from 'lucide-react';
import Header from './components/Header.jsx';
import ContextBar from './components/ContextBar.jsx';
import PipelineStream, { STAGES } from './components/PipelineStream.jsx';
import CodeWorkspace from './components/CodeWorkspace.jsx';
import ImpactPanel from './components/ImpactPanel.jsx';
import CarbonPayback from './components/CarbonPayback.jsx';
import GreenScore from './components/GreenScore.jsx';
import FindingsPanel from './components/FindingsPanel.jsx';
import ReportModal from './components/ReportModal.jsx';
import { BENCHMARKS, LANGUAGES, getBenchmark } from './data/benchmarks.js';
import { computeImpact } from './lib/carbon.js';
import { ping, streamOptimize, verify } from './lib/api.js';

const LANG_ICONS = { python: FileCode2, javascript: Braces, sql: Database };
const idleStages = () => Object.fromEntries(STAGES.map((s) => [s.id, { status: 'idle', summary: '', elapsed: null }]));
const normalize = (s) => (s || '').replace(/\s+$/, '');

// Pacing for the live stream: the backend can finish fast stages in a few ms,
// so events are replayed with a short delay to keep each agent visible.
const EVENT_DELAY = { log: 35, stageDone: 180 };

export default function App() {
  const first = BENCHMARKS[0];
  const [benchmarkId, setBenchmarkId] = useState(first.id);
  const [language, setLanguage] = useState(first.language);
  const [code, setCode] = useState(first.code);
  const [ctx, setCtx] = useState({
    gridRegion: 'india',
    gridIntensity: 716,
    customIntensity: 450,
    hardware: 'cloud',
    callsPerDay: 100_000,
    currency: 'INR',
  });
  const [useLlm, setUseLlm] = useState(true);
  const [backend, setBackend] = useState({ state: 'checking', info: null, error: null });

  const [stages, setStages] = useState(idleStages);
  const [logs, setLogs] = useState([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);

  const [result, setResult] = useState(null);
  const [optimized, setOptimized] = useState('');
  const [measurements, setMeasurements] = useState(null);
  const [verification, setVerification] = useState(null);
  const [optimizedDirty, setOptimizedDirty] = useState(false);
  const [reverifying, setReverifying] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);

  const queue = useRef([]);
  const pumping = useRef(false);
  const abortRef = useRef(null);
  const gotResult = useRef(false);

  // ---------------------------------------------------------------- backend health
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const info = await ping();
        if (!cancelled) setBackend({ state: 'online', info, error: null });
      } catch (e) {
        if (!cancelled) setBackend((b) => ({ state: 'offline', info: b.info, error: e.message }));
      }
    };
    check();
    const id = setInterval(check, 15000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // ---------------------------------------------------------------- stream handling
  const handleEvent = useCallback((ev) => {
    switch (ev.type) {
      case 'stage':
        setStages((s) => ({
          ...s,
          [ev.stage]: {
            status: ev.status,
            summary: ev.summary || s[ev.stage].summary,
            elapsed: ev.elapsed_ms ?? s[ev.stage].elapsed,
          },
        }));
        if (ev.stage === 'refactorer' && ev.status === 'done' && ev.data?.optimized_code) {
          setOptimized(ev.data.optimized_code);
        }
        break;
      case 'log':
        setLogs((l) => [...l, { stage: ev.stage, message: ev.message, level: ev.level }]);
        break;
      case 'result': {
        const r = ev.result;
        gotResult.current = true;
        setResult(r);
        setOptimized(r.optimized_code);
        setMeasurements(r.measurements);
        setVerification(r.verification);
        setOptimizedDirty(false);
        setRunning(false);
        break;
      }
      case 'error':
        setError(ev.message);
        setRunning(false);
        setStages((s) => {
          const next = { ...s };
          for (const k of Object.keys(next)) if (next[k].status === 'running') next[k] = { ...next[k], status: 'error' };
          return next;
        });
        break;
      case '_end':
        if (!gotResult.current) {
          setRunning(false);
          setError((e) => e || 'Stream ended before the pipeline produced a result');
        }
        break;
      default:
        break;
    }
  }, []);

  const pump = useCallback(() => {
    const ev = queue.current.shift();
    if (!ev) {
      pumping.current = false;
      return;
    }
    pumping.current = true;
    handleEvent(ev);
    const delay = ev.type === 'log' ? EVENT_DELAY.log : ev.type === 'stage' && ev.status !== 'running' ? EVENT_DELAY.stageDone : 0;
    setTimeout(pump, delay);
  }, [handleEvent]);

  const enqueue = useCallback(
    (ev) => {
      queue.current.push(ev);
      if (!pumping.current) pump();
    },
    [pump],
  );

  const run = async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    queue.current = [];
    gotResult.current = false;
    setStages(idleStages());
    setLogs([]);
    setError(null);
    setResult(null);
    setMeasurements(null);
    setVerification(null);
    setOptimized('');
    setRunning(true);
    try {
      await streamOptimize(
        {
          code,
          language,
          use_llm: useLlm,
          context: {
            grid_region: ctx.gridRegion,
            grid_intensity: ctx.gridIntensity,
            hardware: ctx.hardware,
            calls_per_day: ctx.callsPerDay,
            currency: ctx.currency,
          },
        },
        enqueue,
        controller.signal,
      );
      enqueue({ type: '_end' });
    } catch (e) {
      if (e.name === 'AbortError') return;
      setRunning(false);
      setError(
        backend.state === 'offline'
          ? `Cannot reach the backend (${e.message}). Start it with: cd backend && uvicorn main:app --port 5000`
          : e.message,
      );
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    queue.current = [];
    setRunning(false);
    setLogs((l) => [...l, { stage: 'pipeline', message: 'Run cancelled by user', level: 'warn' }]);
  };

  // ---------------------------------------------------------------- code & benchmark selection
  const selectBenchmark = (id) => {
    const b = getBenchmark(id);
    setBenchmarkId(id);
    setLanguage(b.language);
    setCode(b.code);
  };

  const changeLanguage = (lang) => {
    setLanguage(lang);
    const match = BENCHMARKS.find((b) => b.language === lang);
    if (match && normalize(code) === normalize(getBenchmark(benchmarkId)?.code)) {
      setBenchmarkId(match.id);
      setCode(match.code);
    } else {
      setBenchmarkId(null);
    }
  };

  const onOriginalChange = (v) => {
    setCode(v);
    const b = getBenchmark(benchmarkId);
    if (b && normalize(v) !== normalize(b.code)) setBenchmarkId(null);
  };

  const onOptimizedChange = (v) => {
    setOptimized(v);
    if (result && normalize(v) !== normalize(result.optimized_code)) setOptimizedDirty(true);
  };

  const reverify = async () => {
    if (!result) return;
    setReverifying(true);
    setLogs((l) => [...l, { stage: 'verifier', message: 'Manual re-verification of edited optimized code…', level: 'info' }]);
    try {
      const r = await verify({ original: result.original_code, optimized, language: result.language });
      setVerification((v) => ({
        ...v,
        status: r.status,
        verified: r.status === 'passed',
        equivalence: { equivalent: r.equivalent, detail: r.detail },
        attempts: [...(v?.attempts || []), { label: 'Manual re-verify', passed: r.equivalent, detail: r.detail }],
        original: r.original || v?.original,
        optimized: r.optimized || v?.optimized,
      }));
      if (r.measurements) {
        setMeasurements((m) => {
          const keepTokens = m?.basis?.tokens === 'estimated';
          const merge = (side) => ({
            ...r.measurements[side],
            ...(keepTokens ? { llm_tokens: m[side].llm_tokens, llm_calls: m[side].llm_calls } : {}),
          });
          return {
            ...m,
            original: merge('original'),
            optimized: merge('optimized'),
            basis: { ...m.basis, time: 'measured', memory: 'measured', carbon: 'measured' },
            speedup: r.speedup,
          };
        });
      }
      setOptimizedDirty(false);
      setLogs((l) => [
        ...l,
        { stage: 'verifier', message: `${r.status.toUpperCase()} - ${r.detail}`, level: r.status === 'passed' ? 'info' : 'error' },
      ]);
    } catch (e) {
      setLogs((l) => [...l, { stage: 'verifier', message: `Re-verify failed: ${e.message}`, level: 'error' }]);
    } finally {
      setReverifying(false);
    }
  };

  const resetOptimized = () => {
    if (!result) return;
    setOptimized(result.optimized_code);
    setMeasurements(result.measurements);
    setVerification(result.verification);
    setOptimizedDirty(false);
  };

  // ---------------------------------------------------------------- derived
  const impact = useMemo(() => computeImpact(result, measurements, ctx), [result, measurements, ctx]);
  const stale = result && normalize(code) !== normalize(result.original_code);
  const verificationStatus = optimizedDirty ? 'stale' : verification?.status;
  const benchmark = getBenchmark(benchmarkId);
  const reportTitle = benchmark?.name || `Custom ${LANGUAGES.find((l) => l.id === language)?.label} code`;

  return (
    <div className="min-h-screen">
      <Header
        backend={backend}
        useLlm={useLlm}
        setUseLlm={setUseLlm}
        currency={ctx.currency}
        setCurrency={(c) => setCtx((x) => ({ ...x, currency: c }))}
        canReport={!!(result && impact && !running)}
        onReport={() => setReportOpen(true)}
      />

      <main className="mx-auto max-w-[1600px] space-y-4 px-4 py-4 lg:px-6">
        <ContextBar ctx={ctx} setCtx={setCtx} />

        {/* Benchmarks + run controls */}
        <section className="panel flex flex-wrap items-center gap-3 p-3">
          <span className="label pl-1">Benchmarks</span>
          <div className="flex flex-1 flex-wrap gap-2">
            {BENCHMARKS.map((b) => {
              const Icon = LANG_ICONS[b.language];
              const on = b.id === benchmarkId;
              return (
                <button
                  key={b.id}
                  type="button"
                  disabled={running}
                  onClick={() => selectBenchmark(b.id)}
                  title={b.description}
                  className={`group flex min-w-[190px] flex-1 items-start gap-2.5 rounded-xl border px-3 py-2 text-left transition disabled:opacity-50 ${
                    on
                      ? 'border-emerald-500/50 bg-emerald-500/10 shadow-glow'
                      : 'border-white/[0.06] bg-white/[0.02] hover:border-emerald-500/30 hover:bg-white/[0.04]'
                  }`}
                >
                  <Icon size={16} className={`mt-0.5 shrink-0 ${on ? 'text-emerald-300' : 'text-slate-500 group-hover:text-slate-300'}`} />
                  <span>
                    <span className={`block text-xs font-semibold ${on ? 'text-emerald-200' : 'text-slate-200'}`}>{b.name}</span>
                    <span className="block text-[10.5px] leading-snug text-slate-500">{b.tagline}</span>
                  </span>
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-2">
            <label className="label" htmlFor="lang">Language</label>
            <select
              id="lang"
              value={language}
              disabled={running}
              onChange={(e) => changeLanguage(e.target.value)}
              className="rounded-lg border border-white/10 bg-ink-800 px-2.5 py-2 text-xs font-semibold text-slate-100 outline-none focus:border-emerald-500/60"
            >
              {LANGUAGES.map((l) => (
                <option key={l.id} value={l.id}>{l.label}</option>
              ))}
            </select>
            {optimizedDirty && (
              <button type="button" className="btn-ghost py-2 text-xs" onClick={resetOptimized} title="Discard edits to the optimized code">
                <Undo2 size={14} /> Reset
              </button>
            )}
            {running ? (
              <button type="button" className="btn-ghost border-red-500/40 py-2 text-red-300" onClick={stop}>
                <Square size={14} /> Stop
              </button>
            ) : (
              <button type="button" className="btn-primary py-2" onClick={run} disabled={!code.trim()}>
                <Play size={15} /> Run pipeline
              </button>
            )}
          </div>
        </section>

        {stale && !running && (
          <div className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-4 py-2 text-xs text-amber-200">
            <AlertTriangle size={14} /> The original code changed since the last run - results below refer to the previous version. Run the pipeline again to refresh.
          </div>
        )}

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
          <CodeWorkspace
            language={language}
            original={code}
            onOriginalChange={onOriginalChange}
            optimized={optimized}
            onOptimizedChange={onOptimizedChange}
            annotations={result?.annotations}
            findingsCount={result?.profile.original.findings.length || 0}
            changesCount={result?.changes.length || 0}
            verificationStatus={verificationStatus}
            onReverify={reverify}
            reverifying={reverifying}
            running={running}
            hasResult={!!result}
          />
          <PipelineStream stages={stages} logs={logs} running={running} error={error} />
        </div>

        <ImpactPanel
          impact={impact}
          measurements={measurements}
          usage={result?.refactor_usage}
          currency={ctx.currency}
          callsPerDay={ctx.callsPerDay}
        />

        <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <GreenScore impact={impact} ctx={ctx} />
          <CarbonPayback impact={impact} basis={measurements?.basis.carbon} callsPerDay={ctx.callsPerDay} />
        </div>

        <FindingsPanel result={result} verification={verification} />

        <footer className="pb-6 pt-2 text-center text-[11px] text-slate-600">
          GreenCode AI · SCI per Green Software Foundation (ISO/IEC 21031) · Measurements from sandboxed differential execution ·
          Estimates are labelled.
        </footer>
      </main>

      <ReportModal
        open={reportOpen && !!result && !!impact}
        onClose={() => setReportOpen(false)}
        result={result}
        impact={impact}
        measurements={measurements}
        verification={verification}
        ctx={ctx}
        title={reportTitle}
        optimizedCode={optimized}
      />
    </div>
  );
}
