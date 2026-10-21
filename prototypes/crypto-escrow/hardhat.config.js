// No HTTP networks, remote RPC URLs, private keys, or mainnet configuration.
export default {
  networks: {
    local: { type: "edr-simulated", chainId: 31337, chainType: "l1", hardfork: "cancun" }
  }
};
