"""Fit a 2-state Gaussian HMM off-chain, once, and emit the on-chain constants.

    python engine/fit_hmm.py

Training runs on bars BEFORE the demo window, never on the crash we replay —
fitting on the event you demo is circular and the first thing a judge attacks.

Only the fit lives here. Inference (the forward filter) is deterministic and
runs on-chain; forward_filter() below is the reference the contract must match.
"""

import json

import numpy as np

from risk_engine import ROOT, compute_scores, load_klines, pick_start, utc

WAD = 10**18
PARAMS_PATH = ROOT / "hmm_params.json"

TRAIN_END_GAP = 1000   # bars of separation between training set and demo window


def forward_filter(returns, p0, mu, sigma, a01, a11):
    """P(turbulent | r_1..r_t) for each t. Online: no future data, no Viterbi.

    This is the exact recursion RegimeVault.sol implements in fixed point.
    Two states only, so the whole belief is one scalar p.
    """
    ln_ratio = np.log(sigma[0] / sigma[1])
    inv0, inv1 = 1 / (2 * sigma[0] ** 2), 1 / (2 * sigma[1] ** 2)

    p, out = p0, []
    for r in returns:
        # predict: mix through the transition matrix (linear, keeps p in (0,1))
        p_pred = a01 + p * (a11 - a01)
        # log-likelihood ratio of turbulent vs calm; the 1/sqrt(2pi) cancels
        d = ln_ratio + (r - mu[0]) ** 2 * inv0 - (r - mu[1]) ** 2 * inv1
        d = float(np.clip(d, -40.0, 40.0))   # p has saturated long before this
        L = np.exp(d)
        # update: Bayes, divided through by b_calm so only the ratio is needed
        p = p_pred * L / (p_pred * L + (1 - p_pred))
        out.append(p)
    return np.array(out)


def main():
    from hmmlearn.hmm import GaussianHMM

    df = compute_scores(load_klines())
    demo_start = pick_start(df)
    train_end = demo_start - TRAIN_END_GAP
    train = df["log_return"].iloc[1:train_end].to_numpy()

    print(f"training on bars 1..{train_end} ({len(train)} bars), "
          f"{utc(df.close_time.iloc[1])} -> {utc(df.close_time.iloc[train_end])}")
    print(f"demo window starts at bar {demo_start} — {TRAIN_END_GAP} bars of separation\n")

    model = GaussianHMM(n_components=2, covariance_type="diag", n_iter=200, random_state=0)
    model.fit(train.reshape(-1, 1))

    # hmmlearn does not label states; the wider one is the turbulent regime.
    sigmas = np.sqrt(model.covars_.ravel())
    calm, turb = int(np.argmin(sigmas)), int(np.argmax(sigmas))
    mu = [float(model.means_.ravel()[calm]), float(model.means_.ravel()[turb])]
    sigma = [float(sigmas[calm]), float(sigmas[turb])]
    a01 = float(model.transmat_[calm][turb])   # calm -> turbulent
    a11 = float(model.transmat_[turb][turb])   # turbulent -> turbulent

    print(f"calm     : mu={mu[0]:+.3e}  sigma={sigma[0]:.6f}  ({sigma[0]*100:.4f} %/min)")
    print(f"turbulent: mu={mu[1]:+.3e}  sigma={sigma[1]:.6f}  ({sigma[1]*100:.4f} %/min)")
    print(f"sigma ratio (turb/calm): {sigma[1]/sigma[0]:.2f}x")
    print(f"P(calm->turb)={a01:.6f}   P(turb->turb)={a11:.6f}")
    print(f"expected turbulent run length: {1/(1-a11):.1f} bars\n")

    assert sigma[1] > sigma[0], "states did not separate"
    assert 0 < a01 < 1 and 0 < a11 < 1, "transitions must be interior so the filter self-heals"

    params = {
        "mu_calm": mu[0], "mu_turb": mu[1],
        "sigma_calm": sigma[0], "sigma_turb": sigma[1],
        "a01": a01, "a11": a11,
        "p0": a01 / (a01 + (1 - a11)),   # stationary P(turbulent)
        "train_bars": int(len(train)),
        "train_from": utc(df.close_time.iloc[1]),
        "train_to": utc(df.close_time.iloc[train_end]),
        "demo_start_bar": int(demo_start),
        # exactly what the contract stores, WAD-scaled
        "onchain": {
            "MU_CALM": round(mu[0] * WAD),
            "MU_TURB": round(mu[1] * WAD),
            "INV_CALM": round(1 / (2 * sigma[0] ** 2) * WAD),
            "INV_TURB": round(1 / (2 * sigma[1] ** 2) * WAD),
            "LN_SIGMA_RATIO": round(np.log(sigma[0] / sigma[1]) * WAD),
            "A01": round(a01 * WAD),
            "A11": round(a11 * WAD),
            "P0": round(a01 / (a01 + (1 - a11)) * WAD),
        },
    }
    PARAMS_PATH.write_text(json.dumps(params, indent=2), encoding="utf-8")

    # Sanity: run the reference filter over the demo window it never saw.
    window = df.iloc[demo_start:demo_start + 240]
    p = forward_filter(window["log_return"].to_numpy(), params["p0"], mu, sigma, a01, a11)
    print(f"out-of-sample on the demo window: P(turbulent) min {p.min():.4f} max {p.max():.4f}")
    print(f"  bars above 0.80: {(p >= 0.80).sum()} / {len(p)}")
    print(f"  first crossing of 0.80 at bar {int(np.argmax(p >= 0.80))} of {len(p)}")
    print(f"\nwrote {PARAMS_PATH}")


if __name__ == "__main__":
    main()
