"""Equivalence check: the on-chain filter must match the Python reference.

    python engine/test_filter.py

Replays every bar of the demo window through both RegimeVault.previewStep()
(Solidity, fixed point) and forward_filter() (numpy, float64) and asserts they
agree. If this passes, the number the contract computes is the number the model
says — which is the entire claim.

Runs against a local EVM rather than the testnet: identical bytecode, but 240
sequential eth_calls against the public RPC gets rate-limited, and a test that
fails for network reasons teaches you nothing about the math.
"""

import json

import numpy as np

from fit_hmm import forward_filter
from oracle import ROOT
from risk_engine import MAX_TICKS, compute_scores, load_klines, pick_start
from test_vault import deploy_local

TOLERANCE = 1e-6
WAD = 10**18


def main():
    w3, c, *_ = deploy_local()
    params = json.loads((ROOT / "hmm_params.json").read_text(encoding="utf-8"))

    df = compute_scores(load_klines())
    start = pick_start(df)
    returns = df["log_return"].iloc[start:start + MAX_TICKS].to_numpy()

    ref = forward_filter(
        returns, params["p0"],
        [params["mu_calm"], params["mu_turb"]],
        [params["sigma_calm"], params["sigma_turb"]],
        params["a01"], params["a11"],
    )

    print(f"replaying {len(returns)} bars through the contract at {c.address} ...")
    assert c.functions.P0().call() == params["onchain"]["P0"], "deployed prior != fitted prior"

    p = c.functions.regimeProb().call()
    onchain = []
    for i, r in enumerate(returns):
        p = c.functions.previewStep(p, int(r * WAD)).call()   # chain feeds its own output
        onchain.append(p / WAD)
        if i % 60 == 0:
            print(f"  bar {i:3d}  chain {p / WAD:.9f}  ref {ref[i]:.9f}")
    onchain = np.array(onchain)

    diff = np.abs(onchain - ref)
    print(f"\nmax  abs difference: {diff.max():.3e}")
    print(f"mean abs difference: {diff.mean():.3e}")
    print(f"bars over 0.80 — chain {int((onchain >= 0.8).sum())}, ref {int((ref >= 0.8).sum())}")

    assert diff.max() < TOLERANCE, f"filters diverged by {diff.max():.3e}"
    assert (onchain >= 0.8).sum() == (ref >= 0.8).sum(), "threshold crossings differ"
    print(f"\nOK — on-chain fixed point matches float64 reference within {TOLERANCE:g}")


if __name__ == "__main__":
    main()
