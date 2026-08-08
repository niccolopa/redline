# Redline — on-chain risk circuit breaker on Monad (1-day hackathon build)

## What we're building
A vault on Monad watched by a deterministic risk engine. When the market
regime flips from calm to turbulent (rolling volatility v1, 2-state HMM
stretch), the vault "redlines": funds move to safe mode on-chain in
under a second. Deterministic math decides, AI only narrates
("Math Firewall"). Demo-first: everything serves a 3-minute live demo.

## Language rule
ALL code, comments, UI copy, commit messages and README in English.

## Folder structure
- /contracts   RedlineVault.sol
- /engine      risk_engine.py, oracle.py, test_tx.py
- /data        crash.csv
- /frontend    Vite app (scaffolded once contracts are stable)

## Stack
- Contracts: Solidity — Foundry if available, else deployed via Remix
- Risk engine + oracle bridge: Python (pandas, hmmlearn, web3.py)
- Frontend: Vite + React + wagmi/viem, wallet = MetaMask
- Network: Monad Testnet — chainId 10143,
  RPC https://rpc.testnet.monad.xyz, explorer https://testnet.monadscan.com

## Rules
- Small steps: one feature at a time, test after every contract change,
  commit every 20–30 min.
- I verify all math myself — the model never invents statistics.
- Simple > clever. Hackathon code. No new features after 17:00.
- Never touch seed phrases or ask for real keys.
- If a fix takes >2 attempts, stop and summarize options instead.

## Workflow automation
- After each completed task: append a 3-line note to HANDOFF.md
  (done / decisions / next step).
- Update the Graphify project graph only at phase boundaries, then
  write a full handoff and I will /clear.

## Current deployed address
(update after each deploy)

## Brand kit
Name: REDLINE. Terminal / trading-desk aesthetic.
Colors: bg #0A0A0A, text #F5F5F0, signal red #FF2D2D, calm green #00C853.
No gradients, no default purple. Type: IBM Plex Mono for numbers,
Inter for labels. Hero element: the horizontal red threshold line.
Big numeric readouts, thin 1px borders.