import { useEffect, useState } from 'react';
import {
  useAccount,
  useConnect,
  useDisconnect,
  useReadContract,
  useSwitchChain,
  useWatchContractEvent,
  useWriteContract,
} from 'wagmi';
import { injected } from 'wagmi/connectors';
import { formatEther, parseEther } from 'viem';

// ==========================================
// CONFIGURATION
// ==========================================
const MONAD_TESTNET = 10143;
const EXPLORER = 'https://testnet.monadscan.com';
const ENGINE_URL = 'http://127.0.0.1:8000'; // risk_engine.py, polled once per second
// From VITE_CONTRACT_ADDRESS in the repo-root .env (vite.config envDir: '..').
// '0x' when unset, so reads fail loudly into the STATUS bar instead of silently.
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
  { inputs: [], name: 'oracle', outputs: [{ name: '', type: 'address' }], stateMutability: 'view', type: 'function' },
  { inputs: [{ name: '', type: 'address' }], name: 'userBalances', outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { anonymous: false, inputs: [{ indexed: false, name: 'score', type: 'int256' }, { indexed: false, name: 'timestamp', type: 'uint256' }], name: 'ScoreUpdated', type: 'event' },
  { anonymous: false, inputs: [{ indexed: false, name: 'timestamp', type: 'uint256' }, { indexed: false, name: 'amountSheltered', type: 'uint256' }, { indexed: true, name: 'triggeredBy', type: 'address' }], name: 'Redlined', type: 'event' },
] as const;

// ==========================================
// ENGINE PAYLOAD (see risk_engine.build_tick)
// ==========================================
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
    symbol: string; source: string; quote: string; interval: string; file: string;
    file_bars: number; file_from: string; file_to: string;
    window_bars: number; window_from: string; window_to: string;
    open_price: number; replay_speed: number; threshold: number;
    weights: { volatility: number; neg_return: number; volume_shock: number };
    windows: { vol: number; z: number; volume: number };
    z_span: number; shock_span: number;
  };
  oracle?: {
    post_ms: number; method: string; post_tx: string; score: number;
    redline_ms?: number; redline_tx?: string; redline_method?: string;
  } | null;
  history?: Tick[];
};

// ==========================================
// FORMATTING — every number on screen carries its unit
// ==========================================
const usd = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (n: number, d = 2) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (n: number, d = 2) => (n > 0 ? '+' : '') + num(n, d) + ' %';
const sigma = (n: number) => (n > 0 ? '+' : '') + num(n, 2) + ' σ';

const C = {
  bg: 'var(--bg)', text: 'var(--text)', red: 'var(--signal-red)',
  green: 'var(--calm-green)', border: 'var(--border)', panel: 'var(--code-bg)',
  mono: 'var(--mono)', sans: 'var(--sans)', dim: '#8A8A85',
};

const panel: React.CSSProperties = {
  border: `1px solid ${C.border}`, background: C.bg, padding: '1.25rem',
  textAlign: 'left', minWidth: 0,
};
const label: React.CSSProperties = {
  fontFamily: C.sans, fontSize: '0.7rem', letterSpacing: '0.12em',
  textTransform: 'uppercase', color: C.dim,
};
const cell: React.CSSProperties = {
  fontFamily: C.mono, fontSize: '0.8rem', padding: '0.45rem 0.5rem',
  borderBottom: `1px solid #2A2A28`, whiteSpace: 'nowrap',
};

// ==========================================
// CHART — price and score share an x-axis. No chart library: one <svg>.
// ==========================================
function Chart({ history, threshold }: { history: Tick[]; threshold: number }) {
  if (history.length < 2) {
    return <div style={{ ...label, padding: '3rem 0', textAlign: 'center' }}>WAITING FOR ENGINE FEED…</div>;
  }
  const W = 1000, H1 = 130, H2 = 110, GAP = 26;
  const prices = history.map((t) => t.close);
  const lo = Math.min(...prices), hi = Math.max(...prices);
  const x = (i: number) => (i / (history.length - 1)) * W;
  const yPrice = (p: number) => H1 - ((p - lo) / (hi - lo || 1)) * (H1 - 8) - 4;
  const yScore = (s: number) => H1 + GAP + (H2 - (s / 100) * H2);
  const line = (pts: string[]) => pts.join(' ');
  const breach = history.findIndex((t) => t.score >= threshold);

  return (
    <svg viewBox={`0 0 ${W} ${H1 + GAP + H2}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
      {/* price */}
      <polyline fill="none" stroke={C.text} strokeWidth="1.5"
        points={line(history.map((t, i) => `${x(i)},${yPrice(t.close)}`))} />
      <text x="4" y="12" fill={C.dim} fontSize="11" fontFamily="IBM Plex Mono">{usd(hi)}</text>
      <text x="4" y={H1 - 2} fill={C.dim} fontSize="11" fontFamily="IBM Plex Mono">{usd(lo)}</text>

      {/* score, filled under the curve */}
      <polygon fill="#FF2D2D18" points={line([`0,${H1 + GAP + H2}`, ...history.map((t, i) => `${x(i)},${yScore(t.score)}`), `${W},${H1 + GAP + H2}`])} />
      <polyline fill="none" stroke={C.red} strokeWidth="1.5"
        points={line(history.map((t, i) => `${x(i)},${yScore(t.score)}`))} />

      {/* THE RED LINE — the hero element */}
      <line x1="0" y1={yScore(threshold)} x2={W} y2={yScore(threshold)} stroke={C.red} strokeWidth="2" />
      <text x="4" y={yScore(threshold) - 5} fill={C.red} fontSize="11" fontFamily="IBM Plex Mono">
        THRESHOLD {threshold}
      </text>
      <text x="4" y={H1 + GAP + H2 - 3} fill={C.dim} fontSize="11" fontFamily="IBM Plex Mono">0</text>

      {/* where the score first crossed */}
      {breach >= 0 && (
        <line x1={x(breach)} y1="0" x2={x(breach)} y2={H1 + GAP + H2} stroke={C.red} strokeWidth="1" strokeDasharray="3 3" />
      )}
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

  // Engine feed: 1 Hz, independent of the chain. This is the DISPLAY path.
  useEffect(() => {
    const poll = () =>
      fetch(ENGINE_URL)
        .then((r) => r.json())
        .then((d) => { setFeed(d); setEngineUp(true); })
        .catch(() => setEngineUp(false));
    poll();
    const id = setInterval(poll, 1000);
    return () => clearInterval(id);
  }, []);

  const read = { address: CONTRACT_ADDRESS, abi: VaultABI } as const;
  const { data: mode, refetch: refetchMode, error: readError } = useReadContract({ ...read, functionName: 'currentMode' });
  const { data: vaultBal, refetch: refetchVault } = useReadContract({ ...read, functionName: 'vaultBalance' });
  const { data: bunkerBal, refetch: refetchBunker } = useReadContract({ ...read, functionName: 'bunkerBalance' });
  const { data: onChainScore, refetch: refetchScore } = useReadContract({ ...read, functionName: 'latestScore' });
  const { data: lastUpdate, refetch: refetchStamp } = useReadContract({ ...read, functionName: 'lastUpdateTimestamp' });
  const { data: threshold } = useReadContract({ ...read, functionName: 'redlineThreshold' });
  const { data: oracleAddr } = useReadContract({ ...read, functionName: 'oracle' });
  const { data: myBal, refetch: refetchMine } = useReadContract({
    ...read, functionName: 'userBalances', args: [address ?? '0x0000000000000000000000000000000000000000'],
  });

  const refetchAll = () => {
    refetchMode(); refetchVault(); refetchBunker(); refetchScore(); refetchStamp(); refetchMine();
  };

  useWatchContractEvent({ ...read, eventName: 'ScoreUpdated', onLogs: () => { refetchScore(); refetchStamp(); } });
  useWatchContractEvent({
    ...read, eventName: 'Redlined',
    onLogs: () => { setFlash(true); setTimeout(() => setFlash(false), 600); refetchAll(); },
  });

  const isRedlined = mode === 1;
  const wrongChain = isConnected && chainId !== MONAD_TESTNET;
  const THRESHOLD = Number(threshold ?? feed?.threshold ?? 70);
  const isOracle = !!address && !!oracleAddr && address.toLowerCase() === oracleAddr.toLowerCase();

  // Score age: how stale the on-chain number is. NOT transaction latency.
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  const scoreAge = lastUpdate && Number(lastUpdate) > 0 ? Math.max(0, Math.round(now / 1000 - Number(lastUpdate))) : null;

  // STATUS: a button that "does nothing" is a swallowed error. Full text, no truncation.
  const err = txError ?? connectError ?? readError;
  const status =
    CONTRACT_ADDRESS === '0x' ? 'NO VITE_CONTRACT_ADDRESS IN .env — RESTART VITE AFTER SETTING IT'
    : err ? err.message.replace(/\s+/g, ' ').slice(0, 240)
    : isPending ? 'TRANSACTION PENDING — CONFIRM IN METAMASK'
    : !isConnected ? 'WALLET DISCONNECTED — READ-ONLY. CONNECT TO DEPOSIT OR WITHDRAW.'
    : wrongChain ? `WRONG NETWORK (chain ${chainId}) — CLICK HERE TO SWITCH TO MONAD TESTNET`
    : `CONNECTED — VAULT ${CONTRACT_ADDRESS}`;
  const isErr = !!err || wrongChain || CONTRACT_ADDRESS === '0x';

  const send = (functionName: 'deposit' | 'withdraw' | 'redline' | 'setMode', extra = {}) => {
    resetTx();
    writeContract({ ...read, functionName, ...extra } as never, { onSuccess: () => setTimeout(refetchAll, 1200) });
  };

  const t = feed as Tick | null;
  const m = feed?.meta;
  const o = feed?.oracle;
  const rows = t && m ? [
    {
      k: 'VOLATILITY', raw: `${num(t.raw.sigma_pct_per_min, 3)} %/min · ${num(t.raw.sigma_pct_annual, 0)} % annualized`,
      sub: `std dev of last ${m.windows.vol} log returns`, z: sigma(t.raw.z_volatility),
      n: t.components.volatility, w: m.weights.volatility, p: t.points.volatility,
    },
    {
      k: 'DOWNSIDE MOVE', raw: `${pct(t.raw.log_return_pct, 3)} this bar`,
      sub: 'log return of the 1-minute bar', z: sigma(t.raw.z_neg_return),
      n: t.components.neg_return, w: m.weights.neg_return, p: t.points.neg_return,
    },
    {
      k: 'VOLUME SHOCK', raw: `${num(t.volume, 0)} ETH · ${num(t.raw.volume_ratio, 2)}× mean`,
      sub: `vs mean of last ${m.windows.volume} bars`, z: '—',
      n: t.components.volume_shock, w: m.weights.volume_shock, p: t.points.volume_shock,
    },
  ] : [];

  return (
    <div style={{
      padding: '1.5rem', maxWidth: '1400px', margin: '0 auto', textAlign: 'left',
      background: flash ? C.red : 'transparent', transition: 'background 0.15s',
    }}>
      {/* ---------- HEADER ---------- */}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: `1px solid ${C.border}`, paddingBottom: '0.9rem' }}>
        <div>
          <div style={{ fontFamily: C.mono, fontSize: '1.5rem', fontWeight: 700, letterSpacing: '0.04em' }}>REDLINE</div>
          <div style={{ ...label, marginTop: 2 }}>ON-CHAIN RISK CIRCUIT BREAKER · MONAD TESTNET (CHAIN 10143)</div>
        </div>
        <button onClick={() => (isConnected ? disconnect() : connect({ connector: injected() }))}
          style={{ fontFamily: C.mono, fontSize: '0.8rem', padding: '0.7rem 1.1rem', background: 'transparent', color: C.text, border: `1px solid ${C.border}`, cursor: 'pointer' }}>
          {isConnected ? `${address?.slice(0, 6)}…${address?.slice(-4)}${isOracle ? ' · ORACLE' : ''}` : 'CONNECT WALLET'}
        </button>
      </header>

      {/* ---------- STATUS ---------- */}
      <div onClick={() => wrongChain && switchChain({ chainId: MONAD_TESTNET })}
        style={{
          fontFamily: C.mono, fontSize: '0.72rem', padding: '0.6rem 0.8rem', margin: '0.9rem 0',
          border: `1px solid ${isErr ? C.red : '#2A2A28'}`, color: isErr ? C.red : C.dim,
          cursor: wrongChain ? 'pointer' : 'default', wordBreak: 'break-word',
        }}>
        STATUS: {status}
      </div>

      {/* ---------- REGIME + THE TWO SCORES ---------- */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
        <div style={{ ...panel, borderColor: isRedlined ? C.red : C.green, borderWidth: 2 }}>
          <div style={label}>Vault regime (on-chain)</div>
          <div style={{ fontFamily: C.mono, fontSize: '2rem', fontWeight: 700, color: isRedlined ? C.red : C.green, lineHeight: 1.3 }}>
            {mode === undefined ? '—' : isRedlined ? 'REDLINED' : 'CALM'}
          </div>
          <div style={{ ...label, textTransform: 'none', color: C.dim }}>
            {isRedlined ? 'Deposits blocked. Funds moved to bunker accounting.' : 'Deposits open. Funds at risk in the vault.'}
          </div>
        </div>

        <div style={panel}>
          <div style={label}>Redline score — computed (engine, 1 Hz)</div>
          <div style={{ fontFamily: C.mono, fontSize: '2.6rem', fontWeight: 700, color: (t?.score ?? 0) >= THRESHOLD ? C.red : C.text, lineHeight: 1.1 }}>
            {t?.score !== undefined ? num(t.score, 2) : '—'}<span style={{ fontSize: '1rem', color: C.dim }}> / 100</span>
          </div>
          <div style={{ ...label, textTransform: 'none' }}>{engineUp ? `Off-chain. Bar ${t?.time ?? ''}` : 'ENGINE OFFLINE — run risk_engine.py'}</div>
        </div>

        <div style={panel}>
          <div style={label}>Redline score — attested (on-chain)</div>
          <div style={{ fontFamily: C.mono, fontSize: '2.6rem', fontWeight: 700, color: Number(onChainScore ?? 0) >= THRESHOLD ? C.red : C.text, lineHeight: 1.1 }}>
            {onChainScore !== undefined ? String(onChainScore) : '—'}<span style={{ fontSize: '1rem', color: C.dim }}> / 100</span>
          </div>
          <div style={{ ...label, textTransform: 'none' }}>
            Integer, written by the oracle · age {scoreAge === null ? '—' : `${scoreAge} s`}
          </div>
        </div>
      </div>

      {/* ---------- CHART ---------- */}
      <div style={{ ...panel, marginBottom: '1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.6rem' }}>
          <div>
            <span style={{ fontFamily: C.mono, fontSize: '1rem', fontWeight: 700 }}>{m?.symbol ?? 'ETH/USDT'}</span>
            <span style={{ ...label, marginLeft: '0.8rem' }}>{m ? `${m.source} · replay ${m.replay_speed}×` : 'engine offline'}</span>
          </div>
          {t && (
            <div style={{ fontFamily: C.mono, fontSize: '0.9rem' }}>
              {usd(t.close)}
              <span style={{ color: t.change_pct < 0 ? C.red : C.green, marginLeft: '0.7rem' }}>
                {pct(t.change_pct)} since window open{m ? ` (${usd(m.open_price)})` : ''}
              </span>
            </div>
          )}
        </div>
        <Chart history={feed?.history ?? []} threshold={THRESHOLD} />
        <div style={{ ...label, marginTop: '0.5rem', textTransform: 'none' }}>
          Top: ETH price in USD. Bottom: Redline score 0–100 with the threshold line at {THRESHOLD}.
          Dashed vertical = first breach. Price and volume are the only inputs; nothing else feeds the score.
        </div>
      </div>

      {/* ---------- SCORE BREAKDOWN ---------- */}
      <div style={{ ...panel, marginBottom: '1rem', overflowX: 'auto' }}>
        <h2 style={{ fontSize: '0.95rem', margin: '0 0 0.2rem' }}>How this score is built</h2>
        <div style={{ ...label, textTransform: 'none', marginBottom: '0.8rem' }}>
          Each factor is measured in its own real units, mapped to 0–100, multiplied by its weight.
          The three point values sum to the score — there is no hidden term.
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: C.mono, fontSize: '0.8rem' }}>
          <thead>
            <tr style={{ ...label, textAlign: 'left' }}>
              {['Factor', 'Raw measurement', 'Std devs', '0–100', '× Weight', '= Points'].map((h) => (
                <th key={h} style={{ ...cell, ...label, borderBottom: `1px solid ${C.border}` }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.k}>
                <td style={cell}>
                  {r.k}
                  <div style={{ ...label, textTransform: 'none', fontSize: '0.62rem' }}>{r.sub}</div>
                </td>
                <td style={{ ...cell, whiteSpace: 'normal' }}>{r.raw}</td>
                <td style={{ ...cell, color: C.dim }}>{r.z}</td>
                <td style={cell}>{num(r.n, 1)}</td>
                <td style={{ ...cell, color: C.dim }}>{num(r.w, 2)}</td>
                <td style={{ ...cell, fontWeight: 700 }}>{num(r.p, 2)}</td>
              </tr>
            ))}
            {t && (
              <tr>
                <td style={{ ...cell, fontWeight: 700, borderBottom: 'none' }} colSpan={5}>REDLINE SCORE</td>
                <td style={{ ...cell, fontWeight: 700, borderBottom: 'none', color: t.score >= THRESHOLD ? C.red : C.text }}>
                  {num(t.score, 2)}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {m && (
          <div style={{ ...label, textTransform: 'none', marginTop: '0.8rem', lineHeight: 1.6 }}>
            Normalization: a z-score of 0 → 0 points, {m.z_span}σ or more → 100. Volume {1}× mean → 0,
            {' '}{1 + m.shock_span}× or more → 100. Both clamped, so a calm market reads 0 rather than negative.
            Z-scores use a rolling {m.windows.z}-bar baseline ({(m.windows.z / 60).toFixed(0)} h), long enough that a
            crash does not quietly raise its own mean. Weights are fixed constants, not fitted.
          </div>
        )}
      </div>

      {/* ---------- PROVENANCE + LATENCY + VAULT ---------- */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.15fr 1fr', gap: '1rem' }}>
        <div style={panel}>
          <h2 style={{ fontSize: '0.95rem', margin: '0 0 0.7rem' }}>Data provenance</h2>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: C.mono, fontSize: '0.76rem' }}>
            <tbody>
              {[
                ['Asset', m?.symbol ?? '—'],
                ['Quote currency', m?.quote ?? '—'],
                ['Source', m ? `${m.source} (${m.interval})` : '—'],
                ['File', m ? `${m.file} — ${m.file_bars.toLocaleString('en-US')} bars` : '—'],
                ['File covers', m ? `${m.file_from} → ${m.file_to}` : '—'],
                ['Replay window', m ? `${m.window_from} → ${m.window_to}` : '—'],
                ['Window length', m ? `${m.window_bars} bars (${(m.window_bars / 60).toFixed(0)} h) at ${m.replay_speed}× speed` : '—'],
                ['Price move', t && m ? `${usd(m.open_price)} → ${usd(t.close)}  (${pct(t.change_pct)})` : '—'],
                ['Event', 'LUNA / UST collapse, 12 May 2022'],
                ['Nature', 'Real historical market data. Replayed, not simulated.'],
              ].map(([k, v]) => (
                <tr key={k}>
                  <td style={{ ...cell, ...label, width: '38%' }}>{k}</td>
                  <td style={{ ...cell, whiteSpace: 'normal' }}>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ ...label, textTransform: 'none', marginTop: '0.8rem', lineHeight: 1.6, color: C.red }}>
            Unit boundary: the risk signal is measured on ETH/USDT in US dollars.
            The vault holds MON on Monad testnet. Testnet MON has no monetary value; ETH is the
            risk proxy, not the deposited asset.
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', minWidth: 0 }}>
          {/* LATENCY */}
          <div style={panel}>
            <h2 style={{ fontSize: '0.95rem', margin: '0 0 0.7rem' }}>Measured on-chain latency</h2>
            <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontFamily: C.mono, fontSize: '2.2rem', fontWeight: 700, color: C.green }}>
                  {o?.redline_ms ?? o?.post_ms ?? '—'}<span style={{ fontSize: '0.9rem', color: C.dim }}> ms</span>
                </div>
                <div style={label}>
                  {o?.redline_ms ? 'redline() send → receipt' : 'postScore() send → receipt'}
                  {o?.method ? ` · ${o.redline_method ?? o.method}` : ''}
                </div>
              </div>
              <div>
                <div style={{ fontFamily: C.mono, fontSize: '2.2rem', fontWeight: 700 }}>
                  {scoreAge === null ? '—' : scoreAge}<span style={{ fontSize: '0.9rem', color: C.dim }}> s</span>
                </div>
                <div style={label}>Age of the attested score</div>
              </div>
            </div>
            <div style={{ ...label, textTransform: 'none', marginTop: '0.7rem', lineHeight: 1.6 }}>
              Left is wall-clock time from transaction send to receipt, measured by the oracle using Monad's
              <code style={{ margin: '0 4px', fontSize: '0.7rem', border: 'none', background: 'transparent', color: C.text }}>eth_sendRawTransactionSync</code>.
              Right is staleness, not speed.
            </div>
            {o?.redline_tx && (
              <a href={`${EXPLORER}/tx/${o.redline_tx}`} target="_blank" rel="noreferrer"
                style={{ ...label, color: C.red, display: 'block', marginTop: '0.6rem' }}>
                VIEW REDLINE TRANSACTION ON MONADSCAN →
              </a>
            )}
          </div>

          {/* VAULT */}
          <div style={{ ...panel, flex: 1 }}>
            <h2 style={{ fontSize: '0.95rem', margin: '0 0 0.7rem' }}>Vault — Monad testnet MON</h2>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: C.mono, fontSize: '0.82rem' }}>
              <tbody>
                {[
                  ['Vault (at risk)', vaultBal, C.text, 'Spendable, exposed while CALM'],
                  ['Bunker (sheltered)', bunkerBal, isRedlined ? C.red : C.dim, 'Moved here on redline'],
                  ['Your position', myBal, C.text, 'Withdrawable in either mode'],
                ].map(([k, v, col, sub]) => (
                  <tr key={k as string}>
                    <td style={{ ...cell, ...label, width: '52%' }}>
                      {k as string}
                      <div style={{ ...label, textTransform: 'none', fontSize: '0.62rem' }}>{sub as string}</div>
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
                DEPOSIT MON
              </button>
            </div>
            <button onClick={() => send('withdraw')} disabled={!isConnected || !myBal || isPending}
              style={{ width: '100%', marginTop: '0.5rem', padding: '0.7rem', background: 'transparent', color: C.text, border: `1px solid ${C.border}`, fontWeight: 700, fontFamily: C.sans, cursor: 'pointer' }}>
              WITHDRAW MY FULL POSITION
            </button>
            <div style={{ ...label, textTransform: 'none', marginTop: '0.5rem' }}>
              {!isConnected ? 'Connect a wallet to move funds.'
                : isRedlined ? 'Deposits blocked while REDLINED. Withdrawals still work.'
                : 'Deposits are native MON from your connected wallet.'}
            </div>

            <div style={{ height: 1, background: '#2A2A28', margin: '1rem 0' }} />

            <button onClick={() => send('redline')}
              disabled={!isConnected || isRedlined || Number(onChainScore ?? 0) < THRESHOLD || isPending}
              style={{ width: '100%', padding: '0.85rem', background: 'transparent', color: C.red, border: `1px solid ${C.red}`, fontWeight: 700, fontFamily: C.sans, cursor: 'pointer' }}>
              PULL THE ALARM — redline()
            </button>
            <div style={{ ...label, textTransform: 'none', marginTop: '0.5rem' }}>
              Callable by anyone. The contract only allows it while the attested score
              ({String(onChainScore ?? '—')}) is at or above {THRESHOLD}.
              {isRedlined && ' Already redlined.'}
            </div>

            {isOracle && (
              <button onClick={() => send('setMode', { args: [isRedlined ? 0 : 1] })} disabled={isPending}
                style={{ width: '100%', marginTop: '0.9rem', padding: '0.5rem', background: C.panel, color: C.dim, border: `1px dashed ${C.border}`, fontFamily: C.sans, fontSize: '0.72rem', cursor: 'pointer' }}>
                [ORACLE ONLY] {isRedlined ? 'RESET TO CALM' : 'FORCE REDLINE'} — demo control
              </button>
            )}
          </div>
        </div>
      </div>

      <footer style={{ ...label, textTransform: 'none', marginTop: '1.2rem', paddingTop: '0.8rem', borderTop: `1px solid #2A2A28`, lineHeight: 1.7 }}>
        Deterministic math decides, AI only narrates — the Math Firewall. Score computed off-chain from price
        and volume alone, attested on-chain by oracle {oracleAddr ? `${oracleAddr.slice(0, 6)}…${oracleAddr.slice(-4)}` : '—'}.
        Vault <a href={`${EXPLORER}/address/${CONTRACT_ADDRESS}`} target="_blank" rel="noreferrer" style={{ color: C.text }}>{CONTRACT_ADDRESS}</a> on MonadScan.
      </footer>
    </div>
  );
}
