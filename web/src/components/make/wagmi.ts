import { defineChain, http } from "viem";
import { baseSepolia } from "viem/chains";
import { createConfig, createStorage, injected, noopStorage } from "wagmi";
import { BASE_SEPOLIA, LASNA } from "@/lib/chains";

export const lasnaChain = defineChain({
  id: LASNA.id,
  name: LASNA.name,
  nativeCurrency: { name: "Lasna REACT", symbol: LASNA.nativeSymbol, decimals: 18 },
  rpcUrls: { default: { http: [LASNA.rpcDefault] } },
  blockExplorers: { default: { name: "Reactscan", url: LASNA.explorer } },
  testnet: true,
});

export const wagmiConfig = createConfig({
  chains: [lasnaChain, baseSepolia],
  connectors: [injected()],
  transports: { [lasnaChain.id]: http(LASNA.rpcDefault), [baseSepolia.id]: http(BASE_SEPOLIA.rpcDefault) },
  ssr: true,
  // Node 26 exposes a global localStorage that warns on the server; only use the browser's.
  storage: createStorage({ storage: typeof window === "undefined" ? noopStorage : window.localStorage }),
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
