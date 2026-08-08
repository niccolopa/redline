"""REDLINE oracle — streams engine events and pushes the score on-chain.

    python engine/oracle.py

Needs PRIVATE_KEY and CONTRACT_ADDRESS, read from the environment or .env
in the repo root.
"""

import json
import os
import time
from pathlib import Path

from web3 import Web3

# --- CONFIG -----------------------------------------------------------------
RPC_URL = "https://testnet-rpc.monad.xyz"
CHAIN_ID = 10143
THRESHOLD = 70.0          # deterministic Redline Score, 0..100
REGIME_THRESHOLD = 0.80   # HMM posterior; must match RegimeVault's constructor

ROOT = Path(__file__).resolve().parent.parent
EVENTS_PATH = ROOT / "events.jsonl"
STATUS_PATH = ROOT / "oracle_status.json"   # read back by risk_engine's HTTP endpoint
EXPLORER = "https://testnet.monadscan.com"

ABI_PATH = ROOT / "abi.json"   # written by deploy.py, always in sync with the deploy
WAD = 10**18

# Fixed limits instead of an estimate_gas round trip per bar. Measured values are
# ~112k for tick() (one exp + two SSTOREs) and ~60k for redline(); these are
# generous ceilings, and unused gas is not charged.
TICK_GAS = 200_000
REDLINE_GAS = 150_000


def load_env():
    """Read KEY=value lines from .env into os.environ without overriding it.

    ponytail: 4 lines instead of python-dotenv. Swap it in if .env grows
    quotes, exports or multiline values.
    """
    env_file = ROOT / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())


def require(name, length=None):
    """Fail with a readable message instead of a hex-decoding traceback."""
    value = os.environ.get(name, "")
    if not value.startswith("0x") or (length and len(value) != length):
        raise SystemExit(
            f"{name} is missing or not set to a real value (got {value!r}).\n"
            f"Put it in {ROOT / '.env'} as {name}=0x..."
        )
    return value


# --- CHAIN ------------------------------------------------------------------


def send_monad_tx(w3, fn, account, nonce, gas, gas_price):
    """Build, sign and send via Monad's sync RPC, falling back to standard send.

    Returns (elapsed_ms, method, tx_hash, receipt). One RPC call on the happy
    path: gas limit and gas price are passed in rather than queried per bar, and
    the receipt comes back from the send itself — that is the whole point of
    eth_sendRawTransactionSync. Querying state afterwards throws it away and,
    at one bar per second, rate-limits the public RPC.
    """
    tx = fn.build_transaction({
        "chainId": CHAIN_ID,
        "from": account.address,
        "nonce": nonce,
        "gas": gas,
        "gasPrice": gas_price,
    })
    raw = account.sign_transaction(tx).raw_transaction
    tx_hash = w3.to_hex(w3.keccak(raw))  # same hash on either path

    start = time.time()
    try:
        response = w3.provider.make_request("eth_sendRawTransactionSync", [w3.to_hex(raw)])
        if "error" in response:
            raise RuntimeError(response["error"])
        return int((time.time() - start) * 1000), "SYNC", tx_hash, response["result"]
    except Exception:
        receipt = w3.eth.wait_for_transaction_receipt(w3.eth.send_raw_transaction(raw))
        return int((time.time() - start) * 1000), "ASYNC", tx_hash, receipt


REGIME_TOPIC = "0x" + Web3.keccak(text="RegimeUpdated(int256,int256,uint256)").hex().lstrip("0x")


def regime_from_receipt(w3, receipt):
    """Pull the new posterior out of the tick receipt — no extra eth_call."""
    for log in receipt.get("logs", []):
        topic = log["topics"][0]
        topic = topic if isinstance(topic, str) else w3.to_hex(topic)
        if topic.lower() != REGIME_TOPIC.lower():
            continue
        data = log["data"]
        raw = bytes.fromhex(data[2:]) if isinstance(data, str) else bytes(data)
        _, prob, _ = w3.codec.decode(["int256", "int256", "uint256"], raw)
        return prob / WAD
    return None


def send_or_die(w3, fn, account, nonce, gas, gas_price, attempts=6):
    """Land this transaction or stop the oracle. Returns (ms, method, tx, receipt, nonce).

    The public RPC rate-limits; backing off fixes that. What must never happen is
    silently continuing past a failed tick() — the contract's HMM belief is a
    recursion, so one missing observation invalidates every value after it.
    """
    for i in range(attempts):
        try:
            ms, method, tx, receipt = send_monad_tx(w3, fn, account, nonce, gas, gas_price)
            return ms, method, tx, receipt, nonce + 1
        except Exception as e:
            print(f"\n  retry {i + 1}/{attempts}: {str(e)[:110]}")
            time.sleep(1.0 * 2**i)
            nonce = w3.eth.get_transaction_count(account.address)
    raise SystemExit(
        "Could not land the transaction after retries. Stopping rather than "
        "skipping a bar: a gap in the observation sequence would silently "
        "desync the on-chain filter from the model."
    )


def publish(**fields):
    """Hand the measured latency to risk_engine's HTTP endpoint for the UI."""
    STATUS_PATH.write_text(json.dumps(fields), encoding="utf-8")


def run_oracle():
    load_env()
    private_key = require("PRIVATE_KEY", length=66)
    contract_address = require("CONTRACT_ADDRESS", length=42)

    w3 = Web3(Web3.HTTPProvider(RPC_URL))
    account = w3.eth.account.from_key(private_key)
    address = w3.to_checksum_address(contract_address)

    # A call to an address with no code is a valid no-op tx: it "succeeds", costs
    # gas and does nothing. Refuse to run rather than fake a working demo.
    if not w3.eth.get_code(address):
        raise SystemExit(
            f"No contract deployed at {address} on {RPC_URL}.\n"
            "Run: python engine/fit_hmm.py && python engine/deploy.py"
        )

    contract = w3.eth.contract(address=address, abi=json.loads(ABI_PATH.read_text(encoding="utf-8")))

    print(f">>> CONNECTED TO MONAD TESTNET: {w3.is_connected()}")
    print(f">>> ORACLE ADDRESS: {account.address}")

    # Priced once, not per bar. 240 bars x an extra gas_price + estimate_gas +
    # regimeProb call is what rate-limits the public RPC.
    nonce = w3.eth.get_transaction_count(account.address)
    gas_price = int(w3.eth.gas_price * 1.25)
    print(f">>> GAS: tick {TICK_GAS:,} / redline {REDLINE_GAS:,} @ {gas_price / 1e9:.1f} gwei")

    redline_triggered = False

    EVENTS_PATH.touch(exist_ok=True)
    events = EVENTS_PATH.open("r", encoding="utf-8")
    # From bar 0, not from the end. The on-chain filter is a recursion over the
    # whole observation sequence; starting mid-stream gives the contract a
    # different history than the reference model and the two stop agreeing.
    events.seek(0)

    print(">>> LISTENING TO ENGINE FEED...")

    while True:
        line = events.readline()
        if not line.strip():
            time.sleep(0.5)
            continue

        event = json.loads(line)
        score = int(event["score"])
        r_wad = int(event["log_return"] * WAD)

        # EVERY bar goes on-chain. The HMM forward filter is a recursion: skipping
        # observations to save gas would make the contract's belief diverge from
        # the reference model. Correctness beats the old "only post big moves".
        print(f"[{event['time']}] score {score:3d}  r {event['log_return']*100:+.3f}%  ->", end=" ")

        # A dropped observation desyncs the on-chain belief from the reference
        # model permanently, so this bar is retried rather than skipped.
        ms, method, tx, receipt, nonce = send_or_die(
            w3, contract.functions.tick(score, r_wad), account, nonce, TICK_GAS, gas_price)

        p = regime_from_receipt(w3, receipt)   # from the receipt, not a second call
        print(f"tick() {ms}ms {method}  P(turbulent)={p:.4f}")
        status = {"post_ms": ms, "method": method, "post_tx": tx,
                  "score": score, "regime_prob": p, "bar": event["time"]}
        publish(**status)

        # Both keys must turn: deterministic score AND the on-chain posterior.
        if score >= THRESHOLD and p >= REGIME_THRESHOLD and not redline_triggered:
            print("  BOTH KEYS TURNED — TRIGGERING REDLINE()...")
            ms, method, tx, _, nonce = send_or_die(
                w3, contract.functions.redline(), account, nonce, REDLINE_GAS, gas_price)
            print(f"  VAULT REDLINED IN {ms}ms ({method})  {EXPLORER}/tx/{tx}")
            redline_triggered = True
            publish(**status, redline_ms=ms, redline_tx=tx, redline_method=method)


if __name__ == "__main__":
    try:
        run_oracle()
    except KeyboardInterrupt:
        print("\nstopped")
