import time
import json
import os
from web3 import Web3

# ==========================================
# CONFIGURATION
# ==========================================
RPC_URL = "https://testnet-rpc.monad.xyz"
CONTRACT_ADDRESS = "0xYOUR_DEPLOYED_CONTRACT_ADDRESS" # Replace this!
PRIVATE_KEY = os.environ.get("PRIVATE_KEY", "YOUR_PRIVATE_KEY_HERE") # Never commit this
EVENTS_FILE = "../events.jsonl"
THRESHOLD = 70.0

# Minimal ABI for Oracle operations
ABI = [
    {"inputs": [{"internalType": "int256", "name": "_score", "type": "int256"}], "name": "postScore", "outputs": [], "stateMutability": "nonpayable", "type": "function"},
    {"inputs": [], "name": "redline", "outputs": [], "stateMutability": "nonpayable", "type": "function"}
]

w3 = Web3(Web3.HTTPProvider(RPC_URL))
account = w3.eth.account.from_key(PRIVATE_KEY)
contract = w3.eth.contract(address=w3.to_checksum_address(CONTRACT_ADDRESS), abi=ABI)

def send_monad_tx(build_tx_func, nonce, gas_buffer=1.075):
    """Builds, signs, and sends tx using Monad's sync RPC, with standard fallback."""
    base_tx = build_tx_func.build_transaction({
        'chainId': 10143,
        'gas': 0, # Will estimate below
        'gasPrice': w3.eth.gas_price,
        'nonce': nonce,
    })
    
    # Monad requires explicitly buffered gas limits
    est_gas = w3.eth.estimate_gas(base_tx)
    base_tx['gas'] = int(est_gas * gas_buffer)
    
    signed_tx = w3.eth.account.sign_transaction(base_tx, private_key=PRIVATE_KEY)
    
    start_time = time.time()
    try:
        # 1. Attempt Monad synchronous transaction
        response = w3.provider.make_request("eth_sendRawTransactionSync", [signed_tx.rawTransaction.hex()])
        elapsed_ms = int((time.time() - start_time) * 1000)
        
        if 'error' in response:
            raise Exception(response['error'])
            
        return elapsed_ms, "SYNC"
    except Exception as e:
        # 2. Fallback to standard EVM send + poll
        tx_hash = w3.eth.send_raw_transaction(signed_tx.rawTransaction)
        w3.eth.wait_for_transaction_receipt(tx_hash)
        elapsed_ms = int((time.time() - start_time) * 1000)
        return elapsed_ms, "ASYNC"

def run_oracle():
    print(f">>> CONNECTED TO MONAD TESTNET: {w3.is_connected()}")
    print(f">>> ORACLE ADDRESS: {account.address}")
    
    nonce = w3.eth.get_transaction_count(account.address)
    redline_triggered = False
    last_score = -1

    # Keep file pointer at the end to stream new lines
    if not os.path.exists(EVENTS_FILE):
        open(EVENTS_FILE, 'w').close()
        
    f = open(EVENTS_FILE, 'r')
    f.seek(0, os.SEEK_END)
    
    print(">>> LISTENING TO ENGINE FEED...")
    
    while True:
        line = f.readline()
        if not line:
            time.sleep(0.5)
            continue
            
        event = json.loads(line.strip())
        current_score = int(event['score'])
        
        # Optimization: Only post if score changed significantly to save MON
        if abs(current_score - last_score) >= 2 or current_score >= THRESHOLD:
            print(f"\n[TICK {event['tick']}] Score: {current_score} | Pushing on-chain...")
            
            try:
                # 1. Post Score
                ms, method = send_monad_tx(contract.functions.postScore(current_score), nonce)
                print(f"✅ postScore() landed in {ms}ms ({method})")
                nonce += 1
                last_score = current_score
                
                # 2. Evaluate Redline
                if current_score >= THRESHOLD and not redline_triggered:
                    print("🚨 THRESHOLD BREACHED. TRIGGERING REDLINE()...")
                    ms_redline, method_redline = send_monad_tx(contract.functions.redline(), nonce)
                    print(f"🛑 VAULT REDLINED IN {ms_redline}ms ({method_redline})")
                    redline_triggered = True
                    nonce += 1
                    
            except Exception as e:
                print(f"❌ TX FAILED: {str(e)[:100]}")

if __name__ == "__main__":
    run_oracle()