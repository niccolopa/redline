import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'

import { createConfig, http, WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { defineChain } from 'viem'

// 1. Define Monad Testnet explicitly
const monadTestnet = defineChain({
  id: 10_143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://testnet-rpc.monad.xyz'] },
  },
  blockExplorers: {
    default: { name: 'MonadScan', url: 'https://testnet.monadscan.com' },
  },
})

// 2. Configure Wagmi
// The public RPC rate-limits hard. Batching collapses the page's ~9 contract
// reads into a single HTTP request, and a slower poll keeps eth_getLogs from
// hammering it. Without both, reads start failing with 429 within a minute.
const config = createConfig({
  chains: [monadTestnet],
  transports: {
    [monadTestnet.id]: http(undefined, {
      batch: { wait: 40 },
      retryCount: 3,
      retryDelay: 800,
    }),
  },
  pollingInterval: 8_000,
})

// 3. Setup React Query Client
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false, // every focus change was another burst of reads
      retry: 2,
    },
  },
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>,
)