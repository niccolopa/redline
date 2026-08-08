
## Monad docs reference (2026-08-08)
Done: saved docs.monad.xyz/llms-full.txt to docs/monad-llms.txt (1.6MB, grep it); read RPC/gas/sync-tx/deploy sections.
Decisions: skip monskills plugin (no faucet/deploy skill, just repackaged docs); use eth_sendRawTransactionSync for the redline tx; set explicit gas limits.
Next: fix RPC URL in CLAUDE.md (testnet-rpc.monad.xyz), then write RedlineVault.sol.

## engine/risk_engine.py (2026-08-08)
Done: pandas feature pipeline + 60x replay thread + stdlib HTTP /state (CORS) + events.jsonl append; --selftest passes; endpoint smoke-tested.
Decisions: formula built exactly as specified (z-vol, z-neg-return, volume shock, weights 0.50/0.35/0.15, sum=1 so score is 0-100 by construction). Window picked by deepest price drop, not by score argmax (score saturates at 100 most days).
Next: BLOCKED ON NICCOLO - score peaks ~19 during the -12% crash. Two causes measured: window opens mid-crash (no calm baseline to z against) and 1-bar return horizon cannot see a 4h grind. Awaiting decision on horizon/window before oracle.py.

## engine/oracle.py + frontend wiring (2026-08-08)
Done: fixed oracle (web3 v7 raw_transaction, .env loader, absolute events path, gas via build_transaction, placeholder guard); frontend reads VITE_CONTRACT_ADDRESS from root .env (vite envDir '..'), added STATUS bar surfacing tx/read/connect/chain errors + one-click chain switch.
Decisions: no contract exists at 0xd9145CCE... (Remix VM sandbox address, 0 bytes on Monad) - the 42 "OK postScore landed" txs were no-ops to a codeless address. Oracle now preflights eth_getCode and refuses to run.
Next: redeploy RedlineVault via Remix -> Injected Provider (MetaMask, Monad Testnet), put the real address in root .env as CONTRACT_ADDRESS + VITE_CONTRACT_ADDRESS.

## Deploy without Remix (2026-08-08)
Done: engine/deploy.py compiles with py-solc-x 0.8.24 and deploys from PRIVATE_KEY; live at 0x14769CE62623A76Eb0add2D8d0Cc9a336649626B; .env + CLAUDE.md updated; abi.json written for the frontend. Smoke test passed: postScore(85) 456ms, redline() 417ms SYNC, mode 0->1, setMode(0) reset.
Decisions: dropped Remix entirely - MetaMask's injected provider never showed up, and deploying from PRIVATE_KEY makes oracle == deployer by construction (no wrong-account footgun).
Next: `npm run dev` and confirm the UI reads mode/balances; then the score-peaks-at-19 blocker is the only thing between us and a real demo.

## Interface rewrite — transparency + units (2026-08-08)
Done: engine tick now carries raw/norm/points + a meta provenance block (symbol, source, file range, window, weights, spans) and serves oracle-measured latency from oracle_status.json; oracle publishes post_ms/redline_ms + tx hashes; App.tsx rewritten with score-build table (raw -> 0-100 -> weight -> points, summing to the score), SVG price+score chart fed from :8000 at 1 Hz, provenance panel, withdraw button, full untruncated errors. Verified: selftest OK, tsc clean, endpoint serves 240-bar history, oracle 145ms SYNC reached the UI payload.
Decisions: show computed (float, 1 Hz, off-chain) and attested (int, on-chain) score side by side - they are different numbers and hiding that was dishonest. Latency and score-age split into two readouts; the old "LAST UPDATE ms" was staleness mislabelled as speed. Unit boundary stated in the UI: signal is ETH/USDT in USD, vault holds testnet MON.
Next: contract has no staleness guard on latestScore - anyone can redline on a stale high score. One-line require() if there is time before freeze.
