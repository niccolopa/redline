
## Monad docs reference (2026-08-08)
Done: saved docs.monad.xyz/llms-full.txt to docs/monad-llms.txt (1.6MB, grep it); read RPC/gas/sync-tx/deploy sections.
Decisions: skip monskills plugin (no faucet/deploy skill, just repackaged docs); use eth_sendRawTransactionSync for the redline tx; set explicit gas limits.
Next: fix RPC URL in CLAUDE.md (testnet-rpc.monad.xyz), then write RedlineVault.sol.

## engine/risk_engine.py (2026-08-08)
Done: pandas feature pipeline + 60x replay thread + stdlib HTTP /state (CORS) + events.jsonl append; --selftest passes; endpoint smoke-tested.
Decisions: formula built exactly as specified (z-vol, z-neg-return, volume shock, weights 0.50/0.35/0.15, sum=1 so score is 0-100 by construction). Window picked by deepest price drop, not by score argmax (score saturates at 100 most days).
Next: BLOCKED ON NICCOLO - score peaks ~19 during the -12% crash. Two causes measured: window opens mid-crash (no calm baseline to z against) and 1-bar return horizon cannot see a 4h grind. Awaiting decision on horizon/window before oracle.py.
