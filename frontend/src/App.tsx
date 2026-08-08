import { useEffect, useState } from 'react';
import {
  useAccount, useConnect, useDisconnect, useReadContract,
  useSwitchChain, useWatchContractEvent, useWriteContract,
} from 'wagmi';
import { injected } from 'wagmi/connectors';
import { formatEther, parseEther } from 'viem';

// ==========================================
// CONFIGURATION
// ==========================================
const MONAD_TESTNET = 10143;
const EXPLORER = 'https://testnet.monadscan.com';
const ENGINE_URL = 'http://127.0.0.1:8000';
const CONTRACT_ADDRESS = (import.meta.env.VITE_CONTRACT_ADDRESS ?? '0x') as `0x${string}`;

const VaultABI = [
  { inputs: [], name: 'deposit', outputs: [], stateMutability: 'payable', type: 'function' },
  { inputs: [], name: 'withdraw', outputs: [], stateMutability: 'nonpayable', type: 'function' },
  { inputs: [], name: 'redline', outputs: [], stateMutability: 'nonpayable', type: 'function' },
  { inputs: [{ name: '_mode', type: 'uint8' }], name: 'setMode', outputs: [], stateMutability: 'nonpayable', type: 'function' },
  { inputs: [], name: 'vaultBalance', outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'bunkerBalance', outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'currentMode', outputs: [{ name: '', type: 'uint8' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'latestScore', outputs: [{ name: '', type: 'int256' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'lastUpdateTimestamp', outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'redlineThreshold', outputs: [{ name: '', type: 'int256' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'regimeProb', outputs: [{ name: '', type: 'int256' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'regimeThreshold', outputs: [{ name: '', type: 'int256' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'barsProcessed', outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'oracle', outputs: [{ name: '', type: 'address' }], stateMutability: 'view', type: 'function' },
  { inputs: [{ name: '', type: 'address' }], name: 'userBalances', outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { anonymous: false, inputs: [{ indexed: false, name: 'logReturn', type: 'int256' }, { indexed: false, name: 'regimeProb', type: 'int256' }, { indexed: false, name: 'timestamp', type: 'uint256' }], name: 'RegimeUpdated', type: 'event' },
  { anonymous: false, inputs: [{ indexed: false, name: 'timestamp', type: 'uint256' }, { indexed: false, name: 'amountSheltered', type: 'uint256' }, { indexed: true, name: 'triggeredBy', type: 'address' }], name: 'Redlined', type: 'event' },
] as const;

type Tick = {
  close_time: number; time: string; close: number; change_pct: number;
  volume: number; score: number; mode: 'CALM' | 'REDLINED';
  components: { volatility: number; neg_return: number; volume_shock: number };
  raw: {
    log_return_pct: number; sigma_pct_per_min: number; sigma_pct_annual: number;
    volume_ratio: number; z_volatility: number; z_neg_return: number;
  };
  points: { volatility: number; neg_return: number; volume_shock: number };
};

type Feed = Partial<Tick> & {
  threshold?: number;
  meta?: {
    live: boolean; symbol: string; source: string; quote: string; interval: string;
    file: string; file_bars: number; file_from: string; file_to: string;
    window_bars: number; window_from: string; window_to: string;
    open_price: number; replay_speed: number; threshold: number;
    weights: { volatility: number; neg_return: number; volume_shock: number };
    windows: { vol: number; z: number; volume: number };
    z_span: number; shock_span: number;
  };
  oracle?: { post_ms: number; method: string; post_tx: string; score: number;
    regime_prob?: number; redline_ms?: number; redline_tx?: string; redline_method?: string } | null;
  // Price of the minute currently forming — moves between bars, so the page
  // has a visible pulse even though the score only recomputes once a minute.
  now?: { price: number; bar_closes_at: number; polled_at: number; stale?: boolean };
  history?: Tick[];
};

// ==========================================
// FORMATTING — every number keeps its unit
// ==========================================
const usd = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (n: number, d = 2) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (n: number, d = 2) => (n > 0 ? '+' : '') + num(n, d) + ' %';
const sig = (n: number) => (n > 0 ? '+' : '') + num(n, 2) + 'σ';

const C = {
  bg: 'var(--bg)', text: 'var(--text)', red: 'var(--signal-red)', green: 'var(--calm-green)',
  border: 'var(--border)', panel: 'var(--code-bg)', mono: 'var(--mono)', sans: 'var(--sans)',
  dim: '#8A8A85', hair: '#2A2A28', amber: '#FFB300',
};

const panel: React.CSSProperties = { border: `1px solid ${C.hair}`, background: C.bg, padding: '1.25rem', textAlign: 'left', minWidth: 0 };
const label: React.CSSProperties = { fontFamily: C.sans, fontSize: '0.7rem', letterSpacing: '0.12em', textTransform: 'uppercase', color: C.dim };
const plain: React.CSSProperties = { fontFamily: C.sans, fontSize: '0.85rem', lineHeight: 1.65, color: '#C8C8C2' };
const cell: React.CSSProperties = { fontFamily: C.mono, fontSize: '0.78rem', padding: '0.45rem 0.5rem', borderBottom: `1px solid ${C.hair}` };
const summary: React.CSSProperties = { ...label, cursor: 'pointer', padding: '0.6rem 0', color: C.text, listStyle: 'revert' };

/** Plain-English band for a 0-100 risk score. */
function band(score: number, threshold: number) {
  if (score >= threshold) return { word: 'DANGER', color: C.red, says: 'Conditions match a crash.' };
  if (score >= threshold * 0.55) return { word: 'ELEVATED', color: C.amber, says: 'Choppier than usual, below the alarm line.' };
  return { word: 'NORMAL', color: C.green, says: 'Nothing unusual in the market.' };
}

// ==========================================
// CHART
// ==========================================
function Chart({ history, threshold }: { history: Tick[]; threshold: number }) {
  if (history.length < 2) {
    return <div style={{ ...label, padding: '3rem 0', textAlign: 'center' }}>WAITING FOR THE ENGINE…</div>;
  }
  const W = 1000, H1 = 120, GAP = 24, H2 = 100;
  const prices = history.map((t) => t.close);
  const lo = Math.min(...prices), hi = Math.max(...prices);
  const x = (i: number) => (i / (history.length - 1)) * W;
  const yP = (p: number) => H1 - ((p - lo) / (hi - lo || 1)) * (H1 - 10) - 5;
  const yS = (s: number) => H1 + GAP + (H2 - (s / 100) * H2);
  const breach = history.findIndex((t) => t.score >= threshold);

  return (
    <svg viewBox={`0 0 ${W} ${H1 + GAP + H2}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
      <polyline fill="none" stroke={C.text} strokeWidth="1.5" points={history.map((t, i) => `${x(i)},${yP(t.close)}`).join(' ')} />
      <text x="4" y="12" fill={C.dim} fontSize="11" fontFamily="IBM Plex Mono">{usd(hi)}</text>
      <text x="4" y={H1 - 2} fill={C.dim} fontSize="11" fontFamily="IBM Plex Mono">{usd(lo)}</text>

      <polygon fill="#FF2D2D18" points={[`0,${H1 + GAP + H2}`, ...history.map((t, i) => `${x(i)},${yS(t.score)}`), `${W},${H1 + GAP + H2}`].join(' ')} />
      <polyline fill="none" stroke={C.red} strokeWidth="1.5" points={history.map((t, i) => `${x(i)},${yS(t.score)}`).join(' ')} />
      <line x1="0" y1={yS(threshold)} x2={W} y2={yS(threshold)} stroke={C.red} strokeWidth="2" />
      <text x="4" y={yS(threshold) - 5} fill={C.red} fontSize="11" fontFamily="IBM Plex Mono">ALARM LINE — {threshold}</text>
      <text x="4" y={H1 + GAP + H2 - 3} fill={C.dim} fontSize="11" fontFamily="IBM Plex Mono">0 = calm</text>
      {breach >= 0 && <line x1={x(breach)} y1="0" x2={x(breach)} y2={H1 + GAP + H2} stroke={C.red} strokeWidth="1" strokeDasharray="3 3" />}
    </svg>
  );
}

// ==========================================
export default function App() {
  const { address, isConnected, chainId } = useAccount();
  const { connect, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const { writeContract, isPending, error: txError, reset: resetTx } = useWriteContract();

  const [feed, setFeed] = useState<Feed | null>(null);
  const [engineUp, setEngineUp] = useState(false);
  const [amount, setAmount] = useState('');
  const [flash, setFlash] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const poll = () => fetch(ENGINE_URL).then((r) => r.json())
      .then((d) => { setFeed(d); setEngineUp(true); })
      .catch(() => setEngineUp(false));
    poll();
    const id = setInterval(poll, 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);

  const read = { address: CONTRACT_ADDRESS, abi: VaultABI } as const;
  const { data: mode, refetch: refetchMode, error: readError } = useReadContract({ ...read, functionName: 'currentMode' });
  const { data: vaultBal, refetch: refetchVault } = useReadContract({ ...read, functionName: 'vaultBalance' });
  const { data: bunkerBal, refetch: refetchBunker } = useReadContract({ ...read, functionName: 'bunkerBalance' });
  const { data: onChainScore, refetch: refetchScore } = useReadContract({ ...read, functionName: 'latestScore' });
  const { data: lastUpdate, refetch: refetchStamp } = useReadContract({ ...read, functionName: 'lastUpdateTimestamp' });
  const { data: threshold } = useReadContract({ ...read, functionName: 'redlineThreshold' });
  const { data: rProb, refetch: refetchRegime } = useReadContract({ ...read, functionName: 'regimeProb' });
  const { data: rGate } = useReadContract({ ...read, functionName: 'regimeThreshold' });
  const { data: bars, refetch: refetchBars } = useReadContract({ ...read, functionName: 'barsProcessed' });
  const { data: oracleAddr } = useReadContract({ ...read, functionName: 'oracle' });
  const { data: myBal, refetch: refetchMine } = useReadContract({
    ...read, functionName: 'userBalances', args: [address ?? '0x0000000000000000000000000000000000000000'],
  });

  const refetchAll = () => {
    refetchMode(); refetchVault(); refetchBunker(); refetchScore();
    refetchStamp(); refetchMine(); refetchRegime(); refetchBars();
  };
  useWatchContractEvent({ ...read, eventName: 'RegimeUpdated', onLogs: () => { refetchScore(); refetchStamp(); refetchRegime(); refetchBars(); } });
  useWatchContractEvent({ ...read, eventName: 'Redlined', onLogs: () => { setFlash(true); setTimeout(() => setFlash(false), 600); refetchAll(); } });

  const t = feed as Tick | null;
  const m = feed?.meta;
  const o = feed?.oracle;
  const isRedlined = mode === 1;
  const wrongChain = isConnected && chainId !== MONAD_TESTNET;
  const TH = Number(threshold ?? feed?.threshold ?? 70);
  const P_TURB = rProb !== undefined ? Number(rProb) / 1e18 : undefined;
  const P_GATE = rGate !== undefined ? Number(rGate) / 1e18 : 0.8;
  const chainScore = onChainScore !== undefined ? Number(onChainScore) : undefined;
  const liveScore = t?.score;
  const key1 = (chainScore ?? 0) >= TH;
  const key2 = (P_TURB ?? 0) >= P_GATE;
  const isOracle = !!address && !!oracleAddr && address.toLowerCase() === oracleAddr.toLowerCase();
  const lag = lastUpdate && Number(lastUpdate) > 0 ? Math.max(0, Math.round(now / 1000 - Number(lastUpdate))) : null;
  const b = band(liveScore ?? 0, TH);
  const myMon = myBal !== undefined ? Number(formatEther(myBal)) : 0;

  // Liveness. A 1-minute bar means the score is SUPPOSED to hold still between
  // bars; these two make the difference between "working" and "frozen" visible.
  const nextBarIn = feed?.now?.bar_closes_at
    ? Math.max(0, Math.ceil((feed.now.bar_closes_at - now) / 1000)) : null;
  const feedAge = feed?.now?.polled_at ? Math.round((now - feed.now.polled_at) / 1000) : null;
  const feedOk = engineUp && feedAge !== null && feedAge < 20;
  const livePrice = feed?.now?.price;
  const drift = livePrice !== undefined && t?.close !== undefined ? livePrice - t.close : undefined;

  const err = txError ?? connectError ?? readError;
  const status =
    CONTRACT_ADDRESS === '0x' ? 'No VITE_CONTRACT_ADDRESS in .env — restart the dev server after setting it.'
    : err ? err.message.replace(/\s+/g, ' ').slice(0, 240)
    : isPending ? 'Transaction pending — confirm it in MetaMask.'
    : !isConnected ? 'Read-only. Connect a wallet to deposit or withdraw.'
    : wrongChain ? `Wrong network (chain ${chainId}). Click here to switch to Monad Testnet.`
    : `Connected to Monad Testnet. Vault ${CONTRACT_ADDRESS}`;
  const isErr = !!err || wrongChain || CONTRACT_ADDRESS === '0x';

  const send = (fn: 'deposit' | 'withdraw' | 'redline' | 'setMode', extra = {}) => {
    resetTx();
    writeContract({ ...read, functionName: fn, ...extra } as never, { onSuccess: () => setTimeout(refetchAll, 1500) });
  };

  const rows = t && m ? [
    { k: 'Price swinging', tech: 'Rolling volatility, 30-bar σ',
      raw: `${num(t.raw.sigma_pct_per_min, 3)} %/min · ${num(t.raw.sigma_pct_annual, 0)} % annualized`,
      z: sig(t.raw.z_volatility), n: t.components.volatility, w: m.weights.volatility, p: t.points.volatility },
    { k: 'Falling this minute', tech: 'Negative log return of the bar',
      raw: pct(t.raw.log_return_pct, 3), z: sig(t.raw.z_neg_return),
      n: t.components.neg_return, w: m.weights.neg_return, p: t.points.neg_return },
    { k: 'Unusual trading volume', tech: 'Volume vs 30-bar mean',
      raw: `${num(t.volume, 0)} ETH · ${num(t.raw.volume_ratio, 2)}× normal`, z: '—',
      n: t.components.volume_shock, w: m.weights.volume_shock, p: t.points.volume_shock },
  ] : [];

  return (
    <div style={{ padding: '1.5rem', maxWidth: '1400px', margin: '0 auto', textAlign: 'left', background: flash ? C.red : 'transparent', transition: 'background 0.15s' }}>

      {/* ---------------- HEADER ---------------- */}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: `1px solid ${C.border}`, paddingBottom: '0.9rem' }}>
        <div>
          <div style={{ fontFamily: C.mono, fontSize: '1.5rem', fontWeight: 700, letterSpacing: '0.04em' }}>REDLINE</div>
          <div style={{ ...plain, fontSize: '0.8rem' }}>
            A savings vault that watches the market and pulls its own money to safety when a crash starts.
          </div>
        </div>
        <button onClick={() => (isConnected ? disconnect() : connect({ connector: injected() }))}
          style={{ fontFamily: C.mono, fontSize: '0.8rem', padding: '0.7rem 1.1rem', background: 'transparent', color: C.text, border: `1px solid ${C.border}`, cursor: 'pointer' }}>
          {isConnected ? `${address?.slice(0, 6)}…${address?.slice(-4)}${isOracle ? ' · operator' : ''}` : 'CONNECT WALLET'}
        </button>
      </header>

      <div onClick={() => wrongChain && switchChain({ chainId: MONAD_TESTNET })}
        style={{ fontFamily: C.mono, fontSize: '0.72rem', padding: '0.6rem 0.8rem', margin: '0.9rem 0', border: `1px solid ${isErr ? C.red : C.hair}`, color: isErr ? C.red : C.dim, cursor: wrongChain ? 'pointer' : 'default', wordBreak: 'break-word' }}>
        {status}
      </div>

      {/* ---------------- DATA SOURCE BANNER ---------------- */}
      <div style={{ ...panel, marginBottom: '1rem', borderColor: m?.live ? C.green : C.amber, display: 'flex', gap: '1rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={{ fontFamily: C.mono, fontWeight: 700, color: m?.live ? C.green : C.amber }}>
          {!engineUp ? '● ENGINE OFFLINE' : m?.live ? '● LIVE MARKET DATA' : '● HISTORICAL REPLAY'}
        </span>
        <span style={{ ...plain, flex: 1, minWidth: '280px' }}>
          {!engineUp ? 'The risk engine is not running. Start it with npm run dev.'
            : m?.live ? <>Real {m.symbol} prices from the public Binance API. <strong>The risk score is
              recalculated once a minute</strong>, when each 1-minute bar closes — so it is meant to hold
              steady in between. The price below updates every few seconds.</>
            : <>Recorded {m?.symbol} prices from {m?.window_from?.slice(0, 10)}, played back at {m?.replay_speed}× speed. Real market history, not a simulation.</>}
        </span>
        {m?.live && (
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontFamily: C.mono, fontSize: '1.35rem', lineHeight: 1.1 }}>
              {livePrice !== undefined ? usd(livePrice) : '—'}
              {drift !== undefined && Math.abs(drift) > 0.004 && (
                <span style={{ fontSize: '0.8rem', color: drift < 0 ? C.red : C.green, marginLeft: '0.4rem' }}>
                  {drift > 0 ? '▲' : '▼'}{num(Math.abs(drift), 2)}
                </span>
              )}
            </div>
            <div style={{ ...label, fontSize: '0.62rem' }}>
              price now · next bar in {nextBarIn === null ? '—' : `${nextBarIn}s`}
            </div>
          </div>
        )}
        <div title={feedOk ? 'Engine responded within the last few seconds' : 'No fresh data from the engine'}
          style={{ ...label, fontSize: '0.62rem', color: feedOk ? C.green : C.red, whiteSpace: 'nowrap' }}>
          {feedOk ? '◉' : '○'} feed {feedAge === null ? 'offline' : `${feedAge}s ago`}
        </div>
      </div>

      {/* ---------------- THE ANSWER ---------------- */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
        <div style={{ ...panel, borderColor: isRedlined ? C.red : C.green, borderWidth: 2 }}>
          <div style={label}>What is happening to your money</div>
          <div style={{ fontFamily: C.mono, fontSize: '2.2rem', fontWeight: 700, color: isRedlined ? C.red : C.green, lineHeight: 1.25, margin: '0.3rem 0' }}>
            {mode === undefined ? '—' : isRedlined ? 'MOVED TO SAFETY' : 'IN THE VAULT'}
          </div>
          <div style={plain}>
            {isRedlined
              ? 'The alarm fired. Every deposit was moved into the bunker and new deposits are blocked. You can still withdraw.'
              : 'The market looks normal, so deposits are open and funds sit in the vault. If a crash starts, they move automatically.'}
          </div>
        </div>

        <div style={{ ...panel, borderColor: b.color }}>
          <div style={label}>Market risk right now</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.8rem', margin: '0.3rem 0' }}>
            <span style={{ fontFamily: C.mono, fontSize: '2.6rem', fontWeight: 700, color: b.color, lineHeight: 1 }}>
              {liveScore !== undefined ? num(liveScore, 1) : '—'}
            </span>
            <span style={{ fontFamily: C.mono, fontSize: '1rem', color: C.dim }}>/ 100</span>
            <span style={{ fontFamily: C.mono, fontWeight: 700, color: b.color }}>{b.word}</span>
          </div>
          <div style={{ position: 'relative', height: '0.9rem', border: `1px solid ${C.hair}`, marginBottom: '0.5rem' }}>
            <div style={{ position: 'absolute', inset: '0 auto 0 0', width: `${Math.min(liveScore ?? 0, 100)}%`, background: b.color }} />
            <div style={{ position: 'absolute', left: `${TH}%`, top: -4, bottom: -4, width: 2, background: C.red }} />
          </div>
          <div style={plain}>{b.says} The alarm line is {TH}: below it nothing happens, at or above it the vault can act.</div>
          <div style={{ ...label, fontSize: '0.62rem', marginTop: '0.4rem' }}>
            {m?.live
              ? `Last recalculated ${t?.time ?? '—'} · next in ${nextBarIn === null ? '—' : `${nextBarIn}s`}`
              : `Bar ${t?.time ?? '—'} · replaying at ${m?.replay_speed ?? '—'}× speed`}
          </div>
        </div>
      </div>

      {/* ---------------- THE TWO CHECKS ---------------- */}
      <div style={{ ...panel, marginBottom: '1rem', borderColor: key1 && key2 ? C.red : C.hair }}>
        <h2 style={{ fontSize: '0.95rem', margin: '0 0 0.3rem' }}>Two independent checks must agree</h2>
        <div style={{ ...plain, marginBottom: '0.9rem' }}>
          Anyone in the world can press the alarm button — but the contract only lets it work when
          two different methods, which look at the data in completely different ways, both say danger.
          One bad minute is not enough to move your money.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem' }}>
          {[
            { name: 'Check 1 — Stress meter', val: `${chainScore ?? '—'} of ${TH} needed`, ok: key1,
              how: 'Adds up how wildly the price swings, how hard it is falling, and how much extra trading there is.' },
            { name: 'Check 2 — Regime model', val: `${P_TURB === undefined ? '—' : num(P_TURB * 100, 1) + '%'} of ${num(P_GATE * 100, 0)}% needed`, ok: key2,
              how: 'Estimates the chance the market has flipped into a "stressed" state and stays there. Calculated by the contract itself.' },
            { name: 'Result', val: key1 && key2 ? 'ALARM CAN RING' : 'ALARM BLOCKED', ok: key1 && key2,
              how: 'Both checks, plus the data must be less than 2 minutes old.' },
          ].map((x) => (
            <div key={x.name} style={{ border: `1px solid ${x.ok ? C.red : C.hair}`, padding: '0.8rem' }}>
              <div style={label}>{x.name}</div>
              <div style={{ fontFamily: C.mono, fontSize: '1rem', fontWeight: 700, color: x.ok ? C.red : C.dim, margin: '0.35rem 0' }}>
                {x.ok ? '✓' : '○'} {x.val}
              </div>
              <div style={{ ...plain, fontSize: '0.75rem' }}>{x.how}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ---------------- CHART + MONEY ---------------- */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
        <div style={panel}>
          <h2 style={{ fontSize: '0.95rem', margin: '0 0 0.3rem' }}>Price and risk over time</h2>
          <div style={{ ...plain, marginBottom: '0.6rem' }}>
            Top line: the {m?.symbol ?? 'ETH'} price in US dollars. Bottom: the risk score, with the red alarm line.
          </div>
          <Chart history={feed?.history ?? []} threshold={TH} />
        </div>

        <div style={panel}>
          <h2 style={{ fontSize: '0.95rem', margin: '0 0 0.3rem' }}>Your money</h2>
          <div style={{ ...plain, marginBottom: '0.9rem' }}>
            <strong>Depositing</strong> puts test coins into the vault so you can watch the circuit breaker
            protect them. This is <strong>test-network MON — it is not real money and has no value.</strong>{' '}
            You can withdraw everything at any time, in either state.
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: C.mono, fontSize: '0.82rem' }}>
            <tbody>
              {[
                ['Your deposit', myBal, C.text, 'Yours. Withdrawable any time.'],
                ['In the vault', vaultBal, C.text, 'Everyone’s funds, exposed while calm.'],
                ['In the bunker', bunkerBal, isRedlined ? C.red : C.dim, 'Everyone’s funds, after the alarm.'],
              ].map(([k, v, col, sub]) => (
                <tr key={k as string}>
                  <td style={{ ...cell, width: '55%' }}>
                    <span style={label}>{k as string}</span>
                    <div style={{ ...plain, fontSize: '0.68rem' }}>{sub as string}</div>
                  </td>
                  <td style={{ ...cell, textAlign: 'right', color: col as string, fontSize: '1rem' }}>
                    {v !== undefined ? num(Number(formatEther(v as bigint)), 4) : '—'} MON
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
            <input type="number" min="0" step="0.01" placeholder="0.00" value={amount}
              onChange={(e) => setAmount(e.target.value)} disabled={isRedlined || !isConnected}
              style={{ flex: 1, minWidth: 0, background: 'transparent', border: `1px solid ${C.border}`, color: C.text, padding: '0.7rem', fontFamily: C.mono }} />
            <button onClick={() => send('deposit', { value: parseEther(amount || '0') })}
              disabled={isRedlined || !isConnected || !Number(amount) || isPending}
              style={{ padding: '0.7rem 1rem', background: isRedlined || !Number(amount) ? C.panel : C.text, color: isRedlined || !Number(amount) ? C.dim : C.bg, border: 'none', fontWeight: 700, fontFamily: C.sans, cursor: 'pointer' }}>
              DEPOSIT
            </button>
          </div>
          <button onClick={() => send('withdraw')} disabled={!isConnected || myMon === 0 || isPending}
            style={{ width: '100%', marginTop: '0.5rem', padding: '0.7rem', background: 'transparent', color: C.text, border: `1px solid ${C.border}`, fontWeight: 700, fontFamily: C.sans, cursor: 'pointer' }}>
            WITHDRAW MY {num(myMon, 4)} MON
          </button>
          <div style={{ ...plain, fontSize: '0.75rem', marginTop: '0.5rem' }}>
            {!isConnected ? 'Connect a wallet first.'
              : isRedlined ? 'New deposits are blocked while the alarm is on. Withdrawing still works.'
              : myMon === 0 ? 'Nothing deposited yet.' : 'Withdraw returns your full balance in one transaction.'}
          </div>

          <div style={{ height: 1, background: C.hair, margin: '1rem 0' }} />
          <button onClick={() => send('redline')} disabled={!isConnected || isRedlined || !key1 || !key2 || isPending}
            style={{ width: '100%', padding: '0.85rem', background: 'transparent', color: key1 && key2 ? C.red : C.dim, border: `1px solid ${key1 && key2 ? C.red : C.hair}`, fontWeight: 700, fontFamily: C.sans, cursor: 'pointer' }}>
            PRESS THE ALARM
          </button>
          <div style={{ ...plain, fontSize: '0.75rem', marginTop: '0.5rem' }}>
            {isRedlined ? 'Already fired.'
              : !key1 && !key2 ? 'Blocked: neither check sees danger.'
              : !key1 ? 'Blocked: the regime model agrees, the stress meter does not.'
              : !key2 ? 'Blocked: the stress meter is over the line, the regime model does not confirm.'
              : 'Both checks agree. Anyone can fire it now.'}
          </div>

          {isOracle && (
            <button onClick={() => send('setMode', { args: [isRedlined ? 0 : 1] })} disabled={isPending}
              style={{ width: '100%', marginTop: '0.9rem', padding: '0.5rem', background: C.panel, color: C.dim, border: `1px dashed ${C.hair}`, fontFamily: C.sans, fontSize: '0.72rem', cursor: 'pointer' }}>
              [operator] {isRedlined ? 'Reset to calm' : 'Force the alarm'} — demo control
            </button>
          )}
        </div>
      </div>

      {/* ---------------- DETAILS: nothing hidden, just folded ---------------- */}
      <div style={panel}>
        <details>
          <summary style={summary}>▸ How the risk score is calculated (every number)</summary>
          <div style={{ ...plain, margin: '0.5rem 0 0.9rem' }}>
            Three measurements, each converted to a 0–100 scale and given a fixed weight.
            The three point values add up to the score exactly — nothing else is involved.
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: C.mono, fontSize: '0.78rem' }}>
              <thead><tr>{['What we measure', 'Actual reading', 'How unusual', '0–100', '× Weight', '= Points'].map((h) => (
                <th key={h} style={{ ...cell, ...label, borderBottom: `1px solid ${C.border}`, textAlign: 'left' }}>{h}</th>))}</tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.k}>
                    <td style={cell}>{r.k}<div style={{ ...plain, fontSize: '0.65rem' }}>{r.tech}</div></td>
                    <td style={{ ...cell, whiteSpace: 'nowrap' }}>{r.raw}</td>
                    <td style={{ ...cell, color: C.dim }}>{r.z}</td>
                    <td style={cell}>{num(r.n, 1)}</td>
                    <td style={{ ...cell, color: C.dim }}>{num(r.w, 2)}</td>
                    <td style={{ ...cell, fontWeight: 700 }}>{num(r.p, 2)}</td>
                  </tr>
                ))}
                {t && <tr><td style={{ ...cell, fontWeight: 700 }} colSpan={5}>TOTAL RISK SCORE</td>
                  <td style={{ ...cell, fontWeight: 700, color: b.color }}>{num(t.score, 2)}</td></tr>}
              </tbody>
            </table>
          </div>
          {m && (
            <div style={{ ...plain, fontSize: '0.75rem', marginTop: '0.8rem' }}>
              “How unusual” is a z-score: how many standard deviations above the average of the last{' '}
              {m.windows.z} minutes ({(m.windows.z / 60).toFixed(0)} hours). {m.z_span}σ or more scores 100.
              Volume is a plain ratio instead: {1 + m.shock_span}× normal or more scores 100. Both are clamped,
              so a calm market reads 0 rather than a negative number. The weights are fixed constants, not fitted to any crash.
            </div>
          )}
        </details>

        <details>
          <summary style={summary}>▸ Why there are two risk numbers, and why they differ</summary>
          <div style={{ ...plain, margin: '0.5rem 0' }}>
            They are the <strong>same measurement at two points in the pipeline</strong>, not two different opinions.
            <ul style={{ margin: '0.6rem 0', paddingLeft: '1.2rem' }}>
              <li><strong>{liveScore !== undefined ? num(liveScore, 2) : '—'} — measured now.</strong> The engine on this machine recomputes it from the newest bar. It has decimals and updates every second.</li>
              <li><strong>{chainScore ?? '—'} — recorded on the blockchain.</strong> The oracle sends the measurement to the contract, which stores it as a whole number. This is the value that controls the money, because it is the only one the contract can see.</li>
            </ul>
            The gap between them is the time it takes to write to the chain — right now{' '}
            <strong>{lag === null ? '—' : `${lag} seconds`}</strong> since the last write. The decimals disappear
            because the contract stores whole numbers. If the two ever drift far apart, the oracle has stopped
            and the contract refuses to act on data older than 2 minutes.
          </div>
        </details>

        <details>
          <summary style={summary}>▸ Where the data comes from</summary>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: C.mono, fontSize: '0.75rem', marginTop: '0.5rem' }}>
            <tbody>
              {[
                ['Mode', m?.live ? 'LIVE — streaming right now' : 'REPLAY — recorded history'],
                ['Asset', m?.symbol ?? '—'],
                ['Priced in', m?.quote ?? '—'],
                ['Source', m?.source ?? '—'],
                ['Bar size', m?.interval ?? '—'],
                ['Bars in view', m ? `${m.window_bars} (${(m.window_bars / 60).toFixed(0)} h)` : '—'],
                ['Covering', m ? `${m.window_from} → ${m.window_to}` : '—'],
                ...(m?.live ? [] : [['Replayed at', m ? `${m.replay_speed}× real time` : '—'],
                                    ['Event', 'LUNA / UST collapse, 12 May 2022'],
                                    ['File', m ? `${m.file} — ${m.file_bars.toLocaleString('en-US')} bars` : '—']]),
              ].map(([k, v]) => (
                <tr key={k as string}><td style={{ ...cell, ...label, width: '30%' }}>{k}</td>
                  <td style={{ ...cell, whiteSpace: 'normal' }}>{v}</td></tr>
              ))}
            </tbody>
          </table>
          <div style={{ ...plain, fontSize: '0.75rem', marginTop: '0.8rem', color: C.amber }}>
            Two different currencies are on this page on purpose. The risk is measured on <strong>ETH priced in
            US dollars</strong>, because that is where a real crash shows up. The vault holds <strong>MON on Monad
            testnet</strong>, which is play money. ETH is the risk signal; MON is what the demo protects.
          </div>
        </details>

        <details>
          <summary style={summary}>▸ Speed, and proof on the blockchain</summary>
          <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap', margin: '0.7rem 0' }}>
            <div>
              <div style={{ fontFamily: C.mono, fontSize: '2rem', fontWeight: 700, color: C.green }}>
                {o?.redline_ms ?? o?.post_ms ?? '—'}<span style={{ fontSize: '0.9rem', color: C.dim }}> ms</span>
              </div>
              <div style={label}>{o?.redline_ms ? 'alarm transaction' : 'last data update'} · {o?.redline_method ?? o?.method ?? '—'}</div>
            </div>
            <div>
              <div style={{ fontFamily: C.mono, fontSize: '2rem', fontWeight: 700 }}>{lag ?? '—'}<span style={{ fontSize: '0.9rem', color: C.dim }}> s</span></div>
              <div style={label}>since the chain was updated</div>
            </div>
            <div>
              <div style={{ fontFamily: C.mono, fontSize: '2rem', fontWeight: 700 }}>{String(bars ?? 0)}</div>
              <div style={label}>bars the contract has processed</div>
            </div>
          </div>
          <div style={{ ...plain, fontSize: '0.75rem' }}>
            The first number is real wall-clock time from sending the transaction to holding its receipt, measured
            by the oracle. It is speed. The second is how long ago the chain was last updated — that is staleness,
            not speed. Two different things, so they get two different boxes.
          </div>
          <div style={{ marginTop: '0.7rem' }}>
            {o?.redline_tx && <a href={`${EXPLORER}/tx/${o.redline_tx}`} target="_blank" rel="noreferrer" style={{ ...label, color: C.red, display: 'block' }}>See the alarm transaction on MonadScan →</a>}
            <a href={`${EXPLORER}/address/${CONTRACT_ADDRESS}`} target="_blank" rel="noreferrer" style={{ ...label, color: C.text, display: 'block', marginTop: '0.3rem' }}>See the vault contract on MonadScan →</a>
          </div>
        </details>

        <details>
          <summary style={summary}>▸ Plain-English glossary</summary>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem', marginTop: '0.5rem' }}>
            <tbody>
              {[
                ['Vault', 'Where deposits sit while the market is normal.'],
                ['Bunker', 'Where deposits are moved when the alarm fires. Same contract, separate accounting.'],
                ['Redline / the alarm', 'The moment the vault decides conditions are dangerous and shelters the funds.'],
                ['Oracle', 'The program that reads the market and reports it to the contract. It reports raw readings, not decisions.'],
                ['Regime', 'Whether the market is in a “calm” or a “stressed” mood. Markets tend to stay in one for a while.'],
                ['Volatility', 'How much the price jumps around. High volatility means large moves in both directions.'],
                ['Log return', 'The price change over one minute, written so that gains and losses are symmetric.'],
                ['z-score (σ)', 'How far from normal something is. 0 is average, 3σ is very rare.'],
                ['Testnet MON', 'Play-money coins on Monad’s test network. They cannot be sold and are worth nothing.'],
              ].map(([k, v]) => (
                <tr key={k}><td style={{ ...cell, width: '22%', fontFamily: C.sans, fontWeight: 700 }}>{k}</td>
                  <td style={{ ...cell, fontFamily: C.sans, whiteSpace: 'normal', color: '#C8C8C2' }}>{v}</td></tr>
              ))}
            </tbody>
          </table>
        </details>
      </div>

      <footer style={{ ...plain, fontSize: '0.75rem', marginTop: '1.2rem', paddingTop: '0.8rem', borderTop: `1px solid ${C.hair}` }}>
        Deterministic math decides, AI only narrates — the Math Firewall. Risk measured from price and volume alone;
        the regime model runs inside the contract. Data reported by {oracleAddr ? `${oracleAddr.slice(0, 6)}…${oracleAddr.slice(-4)}` : '—'}.
      </footer>
    </div>
  );
}
