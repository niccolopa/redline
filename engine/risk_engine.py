"""REDLINE risk engine — replays a Binance 1m crash at 60x and scores the regime.

Deterministic math only. Every formula below is one readable line so it can be
verified by hand against the CSV.

    python engine/risk_engine.py            replay + serve state on PORT
    python engine/risk_engine.py --selftest assert the math, exit
"""

import json
import sys
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import pandas as pd

# --- CONFIG -----------------------------------------------------------------
VOL_WINDOW = 30            # bars in the rolling volatility estimate
Z_WINDOW = 240             # bars used to z-score volatility and returns
VOLUME_WINDOW = 30         # bars in the mean-volume baseline

W_VOLATILITY = 0.50        # weights MUST sum to 1.0 -> score lands in 0..100
W_NEG_RETURN = 0.35
W_VOLUME_SHOCK = 0.15

Z_SPAN = 3.0               # z-score that maps to a component value of 100
SHOCK_SPAN = 3.0           # excess volume ratio mapping to 100 (= 4x mean volume)

REDLINE_THRESHOLD = 70     # must match RedlineVault's constructor argument

REPLAY_SPEED = 60          # minutes of market time per second of wall clock
PRE_ROLL_BARS = 90         # calm bars replayed before the worst bar in the file
MAX_TICKS = 240            # length of the replay window
HISTORY_LEN = 240          # bars handed to the frontend chart

PORT = 8000

ROOT = Path(__file__).resolve().parent.parent
CSV_PATH = ROOT / "data" / "crash.csv"
EVENTS_PATH = ROOT / "events.jsonl"

# Binance 1m kline export, no header row.
COLUMNS = [
    "open_time", "open", "high", "low", "close", "volume",
    "close_time", "quote_volume", "trades", "taker_base", "taker_quote", "ignore",
]

# --- MATH -------------------------------------------------------------------


def load_klines(path=CSV_PATH):
    df = pd.read_csv(path, header=None, names=COLUMNS)
    return df[["close_time", "close", "volume"]].astype(float)


def zscore(series):
    """How many rolling standard deviations above its own rolling mean.

    The baseline must be much longer than the event being detected, or a
    sustained crash raises its own mean and stops looking anomalous.
    """
    return (series - series.rolling(Z_WINDOW).mean()) / series.rolling(Z_WINDOW).std()


def to_0_100(series, span):
    """Map 0..span onto 0..100. Clamped, so calm (negative) reads as 0."""
    return (series / span).clip(0, 1) * 100


def compute_scores(df):
    """Add the three risk components and the REDLINE SCORE to df."""
    close, volume = df["close"], df["volume"]

    # 1. log return of each bar
    df["log_return"] = np.log(close / close.shift(1))

    # 2. rolling volatility = std dev of the last VOL_WINDOW log returns
    df["volatility"] = df["log_return"].rolling(VOL_WINDOW).std()

    # 3. volume shock = this bar's volume against the recent mean volume
    df["volume_shock"] = volume / volume.rolling(VOLUME_WINDOW).mean()

    # z-score the two return-based measures; the shock is already a ratio
    df["z_volatility"] = zscore(df["volatility"])
    df["z_neg_return"] = zscore(-df["log_return"])

    # each component scaled to 0..100 independently
    df["c_volatility"] = to_0_100(df["z_volatility"], Z_SPAN)
    df["c_neg_return"] = to_0_100(df["z_neg_return"], Z_SPAN)
    df["c_volume_shock"] = to_0_100(df["volume_shock"] - 1.0, SHOCK_SPAN)

    # REDLINE SCORE = weighted sum of the three components
    df["score"] = (
        W_VOLATILITY * df["c_volatility"]
        + W_NEG_RETURN * df["c_neg_return"]
        + W_VOLUME_SHOCK * df["c_volume_shock"]
    )
    return df


def pick_start(df):
    """Locate the demo window: PRE_ROLL_BARS of calm, then the worst price drop.

    Selected by price damage, not by score — the score saturates at 100 on most
    days, so its argmax is not a meaningful "worst bar".
    """
    crash_bars = MAX_TICKS - PRE_ROLL_BARS
    drop = df["close"].pct_change(crash_bars)   # price change across crash_bars bars
    crash_start = drop.idxmin() - crash_bars    # steepest decline in the file
    return max(df["score"].first_valid_index(), crash_start - PRE_ROLL_BARS)


# --- REPLAY -----------------------------------------------------------------

CURRENT = {"status": "warming up"}
HISTORY = deque(maxlen=HISTORY_LEN)


def replay(df):
    start = pick_start(df)
    window = df.iloc[start:start + MAX_TICKS]
    print(f"replaying bars {start}..{start + len(window)} at {REPLAY_SPEED}x")

    global CURRENT
    with EVENTS_PATH.open("a", encoding="utf-8") as events:
        for bar in window.itertuples():
            tick = {
                "close_time": int(bar.close_time),
                "close": round(bar.close, 4),
                "volume": round(bar.volume, 4),
                "score": round(bar.score, 2),
                "mode": "REDLINED" if bar.score >= REDLINE_THRESHOLD else "CALM",
                "components": {
                    "volatility": round(bar.c_volatility, 2),
                    "neg_return": round(bar.c_neg_return, 2),
                    "volume_shock": round(bar.c_volume_shock, 2),
                },
            }
            CURRENT = tick
            HISTORY.append(tick)
            events.write(json.dumps(tick) + "\n")
            events.flush()
            print(f"{tick['score']:6.2f}  {tick['mode']:8}  close={tick['close']}")
            time.sleep(60 / REPLAY_SPEED)

    print("replay finished, holding last tick")


# --- HTTP -------------------------------------------------------------------


class Handler(BaseHTTPRequestHandler):
    # ponytail: one endpoint, path ignored. Split it when the frontend needs
    # two different payload shapes.
    def do_GET(self):
        body = json.dumps({
            **CURRENT,
            "threshold": REDLINE_THRESHOLD,
            "history": list(HISTORY),
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")  # Vite dev server is another port
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass  # keep the console readable for score ticks


# --- CHECK ------------------------------------------------------------------


def selftest():
    assert abs(W_VOLATILITY + W_NEG_RETURN + W_VOLUME_SHOCK - 1.0) < 1e-9, "weights must sum to 1"

    # clamping at both ends, 50 in the middle
    assert list(to_0_100(pd.Series([-1.0, 0.0, 1.5, 3.0, 9.0]), 3.0)) == [0, 0, 50, 100, 100]

    # constant +1% bars have identical log returns, so volatility is zero
    steady = pd.Series([100 * 1.01 ** i for i in range(VOL_WINDOW + 1)])
    steady_vol = np.log(steady / steady.shift(1)).rolling(VOL_WINDOW).std().iloc[-1]
    assert steady_vol < 1e-12, f"flat trend should have no volatility, got {steady_vol}"

    df = compute_scores(load_klines())
    scores = df["score"].dropna()
    assert scores.between(0, 100).all(), "score escaped 0..100"
    assert scores.max() > REDLINE_THRESHOLD, "dataset never redlines — retune weights or spans"

    start = pick_start(df)
    replayed = df["score"].iloc[start:start + MAX_TICKS]
    assert replayed.max() > REDLINE_THRESHOLD, "replay window misses the crash"
    print(f"selftest OK — {len(scores)} scored bars, max {scores.max():.2f}, "
          f"replay {start}..{start + MAX_TICKS} peaks at {replayed.max():.2f}")


def main():
    if "--selftest" in sys.argv:
        return selftest()

    df = compute_scores(load_klines())
    threading.Thread(target=replay, args=(df,), daemon=True).start()
    print(f"serving state on http://127.0.0.1:{PORT}  (events -> {EVENTS_PATH})")
    try:
        ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
