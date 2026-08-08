"""REDLINE risk engine — scores the market regime from live or historical bars.

Deterministic math only. Every formula below is one readable line so it can be
verified by hand.

    python engine/risk_engine.py            LIVE ETH/USD from Binance (default)
    python engine/risk_engine.py --replay   historical crash from data/crash.csv
    python engine/risk_engine.py --selftest assert the math, exit

Live is the default because a demo should run on the real market. The replay
exists because a live market is usually calm: it is the only honest way to show
the circuit breaker actually firing. The UI always states which one is running.
"""

import json
import sys
import threading
import time
import urllib.request
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

# Crypto trades 24/7, so a year is 365 * 24 * 60 one-minute bars.
MINUTES_PER_YEAR = 525_600
ANNUALIZE = MINUTES_PER_YEAR ** 0.5   # ~725x, scales per-bar sigma to annual

# What the data actually is. Shown verbatim in the UI — no vague "market data".
SYMBOL = "ETH/USDT"
QUOTE = "USDT (1 USDT ~ 1 USD)"

# LIVE SOURCE: Binance public spot REST API, no key, no account.
# Same 12-column kline schema as data/crash.csv, so both paths share the math.
LIVE_URL = "https://api.binance.com/api/v3/klines"
LIVE_SYMBOL = "ETHUSDT"
LIVE_INTERVAL = "1m"
LIVE_LIMIT = 1000          # ~16.7 h of history; the z-window needs 240 bars
LIVE_POLL_SECONDS = 5      # how often we ask whether a new 1m bar has closed

SOURCE_LIVE = f"Binance spot REST {LIVE_URL} ({LIVE_SYMBOL}, {LIVE_INTERVAL})"
SOURCE_REPLAY = "Binance spot, 1-minute klines (historical file)"

REPLAY_SPEED = 60          # minutes of market time per second of wall clock
PRE_ROLL_BARS = 90         # calm bars replayed before the worst bar in the file
MAX_TICKS = 240            # length of the replay window
HISTORY_LEN = 240          # bars handed to the frontend chart

PORT = 8000

ROOT = Path(__file__).resolve().parent.parent
CSV_PATH = ROOT / "data" / "crash.csv"
EVENTS_PATH = ROOT / "events.jsonl"
STATUS_PATH = ROOT / "oracle_status.json"   # written by oracle.py, served to the UI

# Binance 1m kline export, no header row.
COLUMNS = [
    "open_time", "open", "high", "low", "close", "volume",
    "close_time", "quote_volume", "trades", "taker_base", "taker_quote", "ignore",
]

# --- MATH -------------------------------------------------------------------


def load_klines(path=CSV_PATH):
    df = pd.read_csv(path, header=None, names=COLUMNS)
    return df[["close_time", "close", "volume"]].astype(float)


def fetch_live_klines():
    """Last LIVE_LIMIT closed 1-minute bars of ETH/USDT from Binance.

    The final kline Binance returns is the bar still forming right now, so it is
    dropped — scoring a partial bar would report a volume shock that is only an
    artefact of the minute not being over yet.
    """
    url = f"{LIVE_URL}?symbol={LIVE_SYMBOL}&interval={LIVE_INTERVAL}&limit={LIVE_LIMIT}"
    request = urllib.request.Request(url, headers={"User-Agent": "redline/1.0"})
    with urllib.request.urlopen(request, timeout=15) as response:
        rows = json.load(response)
    df = pd.DataFrame(rows, columns=COLUMNS)
    return df[["close_time", "close", "volume"]].astype(float).iloc[:-1].reset_index(drop=True)


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
META = {}


def utc(ms):
    return time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(ms / 1000))


def describe(df, window, live=False):
    """Everything the UI needs to state its own provenance, no hardcoded strings."""
    return {
        "live": live,
        "symbol": SYMBOL,
        "source": SOURCE_LIVE if live else SOURCE_REPLAY,
        "quote": QUOTE,
        "interval": "1m",
        "file": str(CSV_PATH.relative_to(ROOT)),
        "file_bars": len(df),
        "file_from": utc(df.close_time.iloc[0]),
        "file_to": utc(df.close_time.iloc[-1]),
        "window_bars": len(window),
        "window_from": utc(window.close_time.iloc[0]),
        "window_to": utc(window.close_time.iloc[-1]),
        "open_price": round(window.close.iloc[0], 2),
        "replay_speed": REPLAY_SPEED,
        "threshold": REDLINE_THRESHOLD,
        "weights": {
            "volatility": W_VOLATILITY,
            "neg_return": W_NEG_RETURN,
            "volume_shock": W_VOLUME_SHOCK,
        },
        "windows": {"vol": VOL_WINDOW, "z": Z_WINDOW, "volume": VOLUME_WINDOW},
        "z_span": Z_SPAN,
        "shock_span": SHOCK_SPAN,
    }


def build_tick(bar, open_price):
    """One replay bar -> the full audit trail behind its score.

    raw    = what was measured, in real units
    norm   = that measurement mapped to 0..100
    points = norm * weight, i.e. what it contributed to the score. Points sum
             to the score exactly, so the number on screen is never a mystery.
    """
    norm = {
        "volatility": round(bar.c_volatility, 2),
        "neg_return": round(bar.c_neg_return, 2),
        "volume_shock": round(bar.c_volume_shock, 2),
    }
    return {
        "close_time": int(bar.close_time),
        "time": utc(bar.close_time),
        "close": round(bar.close, 2),
        "change_pct": round((bar.close / open_price - 1) * 100, 2),
        "volume": round(bar.volume, 2),
        "score": round(bar.score, 2),
        "log_return": float(bar.log_return),   # full precision: fed to the on-chain HMM
        "mode": "REDLINED" if bar.score >= REDLINE_THRESHOLD else "CALM",
        "components": norm,
        "raw": {
            "log_return_pct": round(bar.log_return * 100, 3),
            "sigma_pct_per_min": round(bar.volatility * 100, 3),
            "sigma_pct_annual": round(bar.volatility * ANNUALIZE * 100, 1),
            "volume_ratio": round(bar.volume_shock, 2),
            "z_volatility": round(bar.z_volatility, 2),
            "z_neg_return": round(bar.z_neg_return, 2),
        },
        "points": {
            "volatility": round(W_VOLATILITY * norm["volatility"], 2),
            "neg_return": round(W_NEG_RETURN * norm["neg_return"], 2),
            "volume_shock": round(W_VOLUME_SHOCK * norm["volume_shock"], 2),
        },
    }


def replay(df):
    start = pick_start(df)
    window = df.iloc[start:start + MAX_TICKS]
    print(f"replaying bars {start}..{start + len(window)} at {REPLAY_SPEED}x")

    global CURRENT, META
    META = describe(df, window, live=False)
    open_price = window.close.iloc[0]

    # Truncate per run: the oracle replays this file from bar 0 into an on-chain
    # recursion, so it must contain exactly one run's observations and no more.
    with EVENTS_PATH.open("w", encoding="utf-8") as events:
        for bar in window.itertuples():
            tick = build_tick(bar, open_price)
            CURRENT = tick
            HISTORY.append(tick)
            events.write(json.dumps(tick) + "\n")
            events.flush()
            print(f"{tick['score']:6.2f}  {tick['mode']:8}  close={tick['close']}")
            time.sleep(60 / REPLAY_SPEED)

    print("replay finished, holding last tick")


def live_stream():
    """Score the real ETH/USD market, one bar per minute, as bars close.

    Unlike the replay this never ends and nobody chose the window. If the score
    stays near zero all afternoon, that is the correct answer: the market is calm.
    """
    global CURRENT, META

    df = compute_scores(fetch_live_klines())
    warm = df.dropna(subset=["score"])
    META = describe(df, warm, live=True)
    open_price = warm["close"].iloc[0]
    last_seen = None

    print(f"LIVE {SYMBOL} from Binance — {len(df)} bars warmed up, "
          f"latest ${df.close.iloc[-1]:,.2f} at {utc(df.close_time.iloc[-1])}")
    print(f"polling every {LIVE_POLL_SECONDS}s for the next closed 1m bar")

    # Seed the chart with recent history so the UI is not blank for a minute.
    for bar in warm.tail(HISTORY_LEN).itertuples():
        HISTORY.append(build_tick(bar, open_price))
    if HISTORY:
        CURRENT = HISTORY[-1]
        last_seen = CURRENT["close_time"]

    with EVENTS_PATH.open("w", encoding="utf-8") as events:
        while True:
            try:
                df = compute_scores(fetch_live_klines())
            except Exception as e:                      # network blip, not fatal
                print(f"  live fetch failed, retrying: {str(e)[:90]}")
                time.sleep(LIVE_POLL_SECONDS)
                continue

            bar = df.iloc[-1]
            if int(bar.close_time) != last_seen and not pd.isna(bar.score):
                last_seen = int(bar.close_time)
                tick = build_tick(bar, open_price)
                CURRENT = tick
                HISTORY.append(tick)
                events.write(json.dumps(tick) + "\n")
                events.flush()
                print(f"{tick['score']:6.2f}  {tick['mode']:8}  "
                      f"${tick['close']:,.2f}  {tick['time']}")
            time.sleep(LIVE_POLL_SECONDS)


# --- HTTP -------------------------------------------------------------------


def read_oracle_status():
    """Latency the oracle actually measured. ponytail: a file, not a socket —
    two processes, one machine, one direction. Use a queue if it ever grows.
    """
    try:
        return json.loads(STATUS_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


class Handler(BaseHTTPRequestHandler):
    # ponytail: one endpoint, path ignored. Split it when the frontend needs
    # two different payload shapes.
    def do_GET(self):
        body = json.dumps({
            **CURRENT,
            "threshold": REDLINE_THRESHOLD,
            "meta": META,
            "oracle": read_oracle_status(),
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

    if "--replay" in sys.argv:
        df = compute_scores(load_klines())
        worker = threading.Thread(target=replay, args=(df,), daemon=True)
    else:
        worker = threading.Thread(target=live_stream, daemon=True)
    worker.start()

    print(f"serving state on http://127.0.0.1:{PORT}  (events -> {EVENTS_PATH})")
    try:
        ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
