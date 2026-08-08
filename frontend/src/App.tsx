import { useState, useEffect } from 'react';
import { 
  useAccount, 
  useConnect, 
  useDisconnect,
  useWriteContract, 
  useReadContract,
  useWatchContractEvent 
} from 'wagmi';
import { injected } from 'wagmi/connectors';
import { parseEther, formatEther } from 'viem';

// ==========================================
// CONFIGURATION
// ==========================================
const REDLINE_THRESHOLD = 70;
const CONTRACT_ADDRESS = '0xYOUR_DEPLOYED_CONTRACT_ADDRESS'; // Replace after deployment

// Minimal ABI for the UI
const VaultABI = [
  {"inputs":[],"name":"deposit","outputs":[],"stateMutability":"payable","type":"function"},
  {"inputs":[],"name":"redline","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint8","name":"_mode","type":"uint8"}],"name":"setMode","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[],"name":"vaultBalance","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"bunkerBalance","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"currentMode","outputs":[{"internalType":"uint8","name":"","type":"uint8"}],"stateMutability":"view","type":"function"},
  {"anonymous":false,"inputs":[{"indexed":false,"internalType":"int256","name":"score","type":"int256"},{"indexed":false,"internalType":"uint256","name":"timestamp","type":"uint256"}],"name":"ScoreUpdated","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":false,"internalType":"uint256","name":"timestamp","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"amountSheltered","type":"uint256"},{"indexed":true,"internalType":"address","name":"triggeredBy","type":"address"}],"name":"Redlined","type":"event"}
] as const;

export default function App() {
  // Web3 State
  const { address, isConnected } = useAccount();
  const { connect } = useConnect();
  const { disconnect } = useDisconnect();
  const { writeContract } = useWriteContract();

  // Local UI State
  const [score, setScore] = useState<number>(0);
  const [latency, setLatency] = useState<number>(0);
  const [depositAmount, setDepositAmount] = useState<string>('');
  const [flash, setFlash] = useState<boolean>(false);

  // Contract Reads
  const { data: currentMode, refetch: refetchMode } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: VaultABI,
    functionName: 'currentMode',
  });

  const { data: vaultBalance, refetch: refetchVault } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: VaultABI,
    functionName: 'vaultBalance',
  });

  const { data: bunkerBalance, refetch: refetchBunker } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: VaultABI,
    functionName: 'bunkerBalance',
  });

  const mode = currentMode === 1 ? 'REDLINED' : 'CALM';

  // Event Listeners for Real-time Data
  useWatchContractEvent({
    address: CONTRACT_ADDRESS,
    abi: VaultABI,
    eventName: 'ScoreUpdated',
    onLogs(logs) {
      const latestLog = logs[logs.length - 1];
      const eventTimestamp = Number(latestLog.args.timestamp) * 1000; // Convert to ms
      const currentScore = Number(latestLog.args.score);
      
      setScore(currentScore);
      setLatency(Date.now() - eventTimestamp); // Calculate actual on-chain ms latency
    },
  });

  useWatchContractEvent({
    address: CONTRACT_ADDRESS,
    abi: VaultABI,
    eventName: 'Redlined',
    onLogs() {
      // Trigger visual flash and refresh state
      setFlash(true);
      setTimeout(() => setFlash(false), 500);
      refetchMode();
      refetchVault();
      refetchBunker();
    },
  });

  // Handlers
  const handleConnect = () => {
    if (isConnected) disconnect();
    else connect({ connector: injected() });
  };

  const handleDeposit = () => {
    if (!depositAmount) return;
    writeContract({
      address: CONTRACT_ADDRESS,
      abi: VaultABI,
      functionName: 'deposit',
      value: parseEther(depositAmount),
    }, {
      onSuccess: () => {
        setDepositAmount('');
        setTimeout(() => refetchVault(), 1000);
      }
    });
  };

  const handleTriggerAlarm = () => {
    writeContract({
      address: CONTRACT_ADDRESS,
      abi: VaultABI,
      functionName: 'redline',
    });
  };

  const handleSimulateCrash = () => {
    writeContract({
      address: CONTRACT_ADDRESS,
      abi: VaultABI,
      functionName: 'setMode',
      args: [1] // 1 = REDLINED
    }, {
      onSuccess: () => refetchMode()
    });
  };

  // Format balances safely
  const formattedVault = vaultBalance ? Number(formatEther(vaultBalance)).toFixed(2) : '0.00';
  const formattedBunker = bunkerBalance ? Number(formatEther(bunkerBalance)).toFixed(2) : '0.00';

  return (
    <div style={{ 
      padding: '2rem', 
      maxWidth: '1200px', 
      margin: '0 auto',
      backgroundColor: flash ? 'var(--signal-red)' : 'transparent',
      transition: 'background-color 0.1s ease-in-out'
    }}>
      
      {/* HEADER */}
      <header style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '2rem', borderBottom: '1px solid var(--border)', paddingBottom: '1rem' }}>
        <h1 style={{ margin: 0 }}>REDLINE // MONAD_TESTNET</h1>
        <div>
          <button 
            onClick={handleConnect}
            className="numeric-readout"
            style={{ padding: '0.5rem 1rem', cursor: 'pointer', background: 'transparent', color: 'var(--text)' }}
          >
            {isConnected ? `${address?.slice(0,6)}...${address?.slice(-4)}` : 'CONNECT WALLET'}
          </button>
        </div>
      </header>

      {/* REGIME BANNER */}
      <div 
        className={mode === 'CALM' ? 'regime-calm' : 'regime-redlined'}
        style={{ textAlign: 'center', fontSize: '2rem', marginBottom: '2rem' }}
      >
        SYSTEM REGIME: {mode}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '2rem' }}>
        
        {/* LEFT COLUMN: TELEMETRY */}
        <section>
          <div style={{ border: '1px solid var(--border)', padding: '2rem', marginBottom: '2rem', backgroundColor: 'var(--bg)' }}>
            <h2>RISK SCORE TELEMETRY</h2>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '1rem' }}>
              <span style={{ fontSize: '4rem', fontFamily: 'var(--mono)' }}>{score.toFixed(2)}</span>
              <span className="numeric-readout" style={{ padding: '0.5rem' }}>LAST UPDATE: {latency}ms</span>
            </div>
            
            {/* Visual Bar */}
            <div style={{ position: 'relative', height: '2rem', border: '1px solid var(--border)', width: '100%' }}>
              <div style={{ 
                position: 'absolute', 
                left: 0, top: 0, bottom: 0, 
                width: `${Math.min(score, 100)}%`, 
                backgroundColor: score >= REDLINE_THRESHOLD ? 'var(--signal-red)' : 'var(--text)',
                transition: 'width 0.2s linear'
              }} />
              {/* The Red Line */}
              <div style={{
                position: 'absolute',
                left: `${REDLINE_THRESHOLD}%`,
                top: '-10px',
                bottom: '-10px',
                width: '2px',
                backgroundColor: 'var(--signal-red)',
                zIndex: 10
              }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.5rem', fontFamily: 'var(--mono)', fontSize: '0.8rem' }}>
              <span>0.00</span>
              <span style={{ color: 'var(--signal-red)' }}>THRESHOLD: {REDLINE_THRESHOLD}.00</span>
              <span>100.00</span>
            </div>
          </div>

          <div style={{ border: '1px solid var(--border)', padding: '2rem', height: '300px', display: 'flex', flexDirection: 'column', backgroundColor: 'var(--bg)' }}>
            <h2>MARKET FEED (60x REPLAY)</h2>
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--mono)', color: 'var(--code-bg)' }}>
              [ CHART ENDPOINT AWAITING PHASE 4 INTEGRATION ]
            </div>
          </div>
        </section>

        {/* RIGHT COLUMN: VAULT CONTROLS */}
        <section>
          <div style={{ border: '1px solid var(--border)', padding: '2rem', backgroundColor: 'var(--bg)' }}>
            <h2>VAULT ACCOUNTING</h2>
            
            <div style={{ margin: '2rem 0', fontFamily: 'var(--mono)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem' }}>
                <span>VAULT (AT RISK):</span>
                <span>{formattedVault} MON</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: mode === 'REDLINED' ? 'var(--signal-red)' : 'inherit' }}>
                <span>BUNKER (SAFE):</span>
                <span>{formattedBunker} MON</span>
              </div>
            </div>

            <hr style={{ borderColor: 'var(--border)', margin: '2rem 0' }} />

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <input 
                type="number" 
                placeholder="Amount (MON)" 
                value={depositAmount}
                onChange={(e) => setDepositAmount(e.target.value)}
                disabled={mode === 'REDLINED' || !isConnected}
                style={{ 
                  background: 'transparent', 
                  border: '1px solid var(--border)', 
                  color: 'var(--text)', 
                  padding: '1rem',
                  fontFamily: 'var(--mono)'
                }} 
              />
              <button 
                onClick={handleDeposit}
                disabled={mode === 'REDLINED' || !isConnected}
                style={{ 
                  padding: '1rem', 
                  background: mode === 'REDLINED' ? 'var(--code-bg)' : 'var(--text)', 
                  color: mode === 'REDLINED' ? 'var(--text)' : 'var(--bg)', 
                  border: 'none',
                  cursor: (mode === 'REDLINED' || !isConnected) ? 'not-allowed' : 'pointer',
                  fontWeight: 'bold',
                  fontFamily: 'var(--sans)'
                }}
              >
                DEPOSIT FUNDS
              </button>
            </div>

            <hr style={{ borderColor: 'var(--border)', margin: '2rem 0' }} />

            <button 
              onClick={handleTriggerAlarm}
              style={{ 
                width: '100%',
                padding: '1rem', 
                background: 'transparent', 
                color: 'var(--signal-red)', 
                border: '1px solid var(--signal-red)',
                cursor: 'pointer',
                fontWeight: 'bold',
                fontFamily: 'var(--sans)'
              }}
            >
              PULL ALARM (redline)
            </button>
            <p style={{ fontSize: '0.8rem', marginTop: '1rem', color: '#888' }}>
              Anyone can call redline(), but the Monad runtime will revert the transaction if the math oracle disagrees.
            </p>

            <button 
              onClick={handleSimulateCrash}
              style={{ 
                width: '100%',
                marginTop: '2rem',
                padding: '0.5rem', 
                background: 'var(--code-bg)', 
                color: 'var(--text)', 
                border: '1px dashed var(--border)',
                cursor: 'pointer',
                fontFamily: 'var(--sans)',
                fontSize: '0.8rem'
              }}
            >
              [DEBUG] SIMULATE CRASH
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}