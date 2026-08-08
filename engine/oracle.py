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
THRESHOLD = 70.0

ROOT = Path(__file__).resolve().parent.parent
EVENTS_PATH = ROOT / "events.jsonl"
STATUS_PATH = ROOT / "oracle_status.json"   # read back by risk_engine's HTTP endpoint
EXPLORER = "https://testnet.monadscan.com"

# Minimal ABI for oracle operations
ABI = [
    {"inputs": [{"internalType": "int256", "name": "_score", "type": "int256"}], "name": "postScore", "outputs": [], "stateMutability": "nonpayable", "type": "function"},
    {"inputs": [], "name": "redline", "outputs": [], "stateMutability": "nonpayable", "type": "function"},
]


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


def send_monad_tx(w3, fn, account, nonce, gas_buffer=1.075):
    """Build, sign and send via Monad's sync RPC, falling back to standard send.

    Returns (elapsed_ms, method, tx_hash). elapsed_ms is wall clock from send to
    receipt — the number the demo puts on screen, so it must be honest.
    """
    tx = fn.build_transaction({
        "chainId": CHAIN_ID,
        "from": account.address,
        "nonce": nonce,
    })
    tx["gas"] = int(tx["gas"] * gas_buffer)  # Monad wants headroom on the limit

    signed = account.sign_transaction(tx)
    raw = signed.raw_transaction
    tx_hash = w3.to_hex(w3.keccak(raw))  # same hash on either path

    start = time.time()
    try:
        response = w3.provider.make_request("eth_sendRawTransactionSync", [w3.to_hex(raw)])
        if "error" in response:
            raise RuntimeError(response["error"])
        return int((time.time() - start) * 1000), "SYNC", tx_hash
    except Exception:
        w3.eth.wait_for_transaction_receipt(w3.eth.send_raw_transaction(raw))
        return int((time.time() - start) * 1000), "ASYNC", tx_hash


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
            "Deploy RedlineVault with Remix -> Injected Provider (MetaMask), not the Remix VM."
        )

    contract = w3.eth.contract(address=address, abi=ABI)

    print(f">>> CONNECTED TO MONAD TESTNET: {w3.is_connected()}")
    print(f">>> ORACLE ADDRESS: {account.address}")

    nonce = w3.eth.get_transaction_count(account.address)
    redline_triggered = False
    last_score = -100

    EVENTS_PATH.touch(exist_ok=True)
    events = EVENTS_PATH.open("r", encoding="utf-8")
    events.seek(0, os.SEEK_END)  # only stream lines written from now on

    print(">>> LISTENING TO ENGINE FEED...")

    while True:
        line = events.readline()
        if not line.strip():
            time.sleep(0.5)
            continue

        event = json.loads(line)
        score = int(event["score"])

        # Only post on a real move, to save MON
        if abs(score - last_score) < 2 and score < THRESHOLD:
            continue

        print(f"\n[{event['close_time']}] Score: {score} | Pushing on-chain...")
        try:
            ms, method, tx = send_monad_tx(w3, contract.functions.postScore(score), account, nonce)
            print(f"OK postScore() landed in {ms}ms ({method})")
            nonce += 1
            last_score = score
            status = {"post_ms": ms, "method": method, "post_tx": tx, "score": score}
            publish(**status)

            if score >= THRESHOLD and not redline_triggered:
                print("THRESHOLD BREACHED. TRIGGERING REDLINE()...")
                ms, method, tx = send_monad_tx(w3, contract.functions.redline(), account, nonce)
                print(f"VAULT REDLINED IN {ms}ms ({method})")
                redline_triggered = True
                nonce += 1
                publish(**status, redline_ms=ms, redline_tx=tx, redline_method=method)
        except Exception as e:
            print(f"TX FAILED: {str(e)[:200]}")
            nonce = w3.eth.get_transaction_count(account.address)  # resync after a drop


if __name__ == "__main__":
    try:
        run_oracle()
    except KeyboardInterrupt:
        print("\nstopped")
