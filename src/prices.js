// Crypto prices, used to turn a deal's agreed value (say $2,400.00) into an exact coin amount
// when the buyer asks for a deposit invoice. The amount is then locked on that invoice.
// CoinGecko first, Coinbase as a fallback. Prices are cached for a minute.
const { ApiError } = require("./errors");

const IDS = { BTC: "bitcoin", LTC: "litecoin", ETH: "ethereum", SOL: "solana" };
const FIATS = ["usd", "aud", "nzd", "gbp", "eur", "cad"];

function createPrices({ fetchImpl = (...a) => fetch(...a), now = () => Date.now(), ttlMs = 60 * 1000, log = console } = {}) {
  let cache = null; // { at, data: { BTC: { usd: 98000.12, ... } } }

  const usable = (data) => Object.keys(IDS).every((s) => data[s] && FIATS.every((f) => Number(data[s][f]) > 0));

  async function fromCoinGecko() {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${Object.values(IDS).join(",")}&vs_currencies=${FIATS.join(",")}`;
    const r = await fetchImpl(url, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`CoinGecko answered ${r.status}`);
    const j = await r.json();
    const data = {};
    for (const [sym, id] of Object.entries(IDS)) data[sym] = j[id];
    if (!usable(data)) throw new Error("CoinGecko returned incomplete prices");
    return data;
  }

  async function fromCoinbase() {
    const data = {};
    for (const sym of Object.keys(IDS)) {
      const r = await fetchImpl(`https://api.coinbase.com/v2/exchange-rates?currency=${sym}`, { headers: { accept: "application/json" } });
      if (!r.ok) throw new Error(`Coinbase answered ${r.status}`);
      const rates = (await r.json()).data.rates;
      data[sym] = Object.fromEntries(FIATS.map((f) => [f, Number(rates[f.toUpperCase()])]));
    }
    if (!usable(data)) throw new Error("Coinbase returned incomplete prices");
    return data;
  }

  async function all() {
    if (cache && now() - cache.at < ttlMs) return cache.data;
    let data;
    try {
      data = await fromCoinGecko();
    } catch (err) {
      log.error?.("Price lookup (CoinGecko) failed, trying Coinbase:", err.message);
      try {
        data = await fromCoinbase();
      } catch (err2) {
        log.error?.("Price lookup (Coinbase) failed:", err2.message);
        throw new ApiError(503, "prices_unavailable", "Couldn't get a live price for that coin right now. Try again in a minute.");
      }
    }
    cache = { at: now(), data };
    return data;
  }

  // Price of one whole coin in the given fiat currency, e.g. rate("BTC", "usd") -> 98000.12
  async function rate(asset, fiat) {
    const data = await all();
    const value = Number(data[asset] && data[asset][String(fiat).toLowerCase()]);
    if (!(value > 0)) throw new ApiError(503, "prices_unavailable", `No live ${asset} price in ${String(fiat).toUpperCase()} right now.`);
    return value;
  }

  return { rate, all };
}

module.exports = { createPrices, IDS, FIATS };
