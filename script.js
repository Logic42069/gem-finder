/*
 * Gem Finder - client-side logic
 *
 * This script fetches market data from CoinGecko, including multiple pages
 * of tokens ordered by 24h trading volume, combines it with trending search
 * coins, computes a momentum score based on price change and volume, and
 * then ranks tokens by this score. Trending coins are highlighted in the
 * table. A search function and interactive refresh are provided.
 */

// Data arrays
let tokens = [];
let filteredTokens = [];

// DOM elements
const tokensTable = document.getElementById("tokens-table");
const tokensBody = document.getElementById("tokens-body");
const searchInput = document.getElementById("search-input");
const refreshButton = document.getElementById("refresh-button");
const statusEl = document.getElementById("status");
const scanEl = document.getElementById("scan-animation");

// Utility: format large numbers with commas and abbreviations
function formatNumber(value) {
  if (value === null || value === undefined) return "-";
  const absValue = Math.abs(value);
  if (absValue >= 1e12) {
    return (value / 1e12).toFixed(2) + "T";
  }
  if (absValue >= 1e9) {
    return (value / 1e9).toFixed(2) + "B";
  }
  if (absValue >= 1e6) {
    return (value / 1e6).toFixed(2) + "M";
  }
  if (absValue >= 1e3) {
    return (value / 1e3).toFixed(2) + "K";
  }
  return value.toLocaleString();
}

// Fetch BloFin perpetual tickers and compute momentum‑based ranking.
async function fetchData() {
  statusEl.textContent = "Fetching data...";
  statusEl.style.display = "block";
  tokensTable.classList.add("hidden");
  if (scanEl) scanEl.classList.remove("hidden");
  try {
    // Retrieve the list of all instruments and filter for perpetual (SWAP) contracts that are live
    let instruments = [];
    try {
      const instRes = await fetch(
        "https://openapi.blofin.com/api/v1/market/instruments"
      );
      if (instRes.ok) {
        const instJson = await instRes.json();
        if (Array.isArray(instJson.data)) {
          instruments = instJson.data.filter(
            (inst) => inst.instType === "SWAP" && inst.state === "live"
          );
        }
      } else {
        console.warn("BloFin instruments request returned non-OK response");
      }
    } catch (e) {
      console.warn("Failed to fetch BloFin instruments", e);
    }
    // Stable base currencies to exclude
    const stableBases = new Set([
      "USDT",
      "USDC",
      "USD",
      "BUSD",
      "DAI",
      "TUSD",
      "PAX",
      "USDP",
      "USDK",
      "USDD",
      "EUR",
      "JPY",
      "GBP",
    ]);
    // Group instrument IDs by base currency
    const instrumentsByBase = {};
    instruments.forEach((inst) => {
      const base = inst.baseCurrency;
      if (!base || stableBases.has(base)) return;
      if (!instrumentsByBase[base]) instrumentsByBase[base] = [];
      instrumentsByBase[base].push(inst.instId);
    });
    const baseCurrencies = Object.keys(instrumentsByBase);
    if (baseCurrencies.length === 0) {
      statusEl.textContent = "No BloFin perpetual instruments found.";
      if (scanEl) scanEl.classList.add("hidden");
      return;
    }
    // Fetch tickers for all SWAP instruments
    const tickerMap = {};
    try {
      const tickRes = await fetch(
        "https://openapi.blofin.com/api/v1/market/tickers?instType=SWAP"
      );
      if (tickRes.ok) {
        const tickJson = await tickRes.json();
        if (Array.isArray(tickJson.data)) {
          tickJson.data.forEach((tick) => {
            tickerMap[tick.instId] = tick;
          });
        }
      } else {
        console.warn("BloFin tickers request returned non-OK response");
      }
    } catch (e) {
      console.warn("Failed to fetch BloFin tickers", e);
    }
    // Aggregate metrics by base currency
    const aggregated = [];
    let maxVolume = 0;
    for (const base of baseCurrencies) {
      const instIds = instrumentsByBase[base];
      let totalVolume = 0;
      let primaryTicker = null;
      instIds.forEach((instId) => {
        const tick = tickerMap[instId];
        if (!tick) return;
        const vol = parseFloat(tick.volCurrency24h);
        if (isNaN(vol)) return;
        totalVolume += vol;
        if (!primaryTicker || parseFloat(primaryTicker.volCurrency24h) < vol) {
          primaryTicker = tick;
        }
      });
      if (!primaryTicker || totalVolume <= 0) continue;
      // Track the maximum volume observed across all base currencies for later normalization
      maxVolume = Math.max(maxVolume, totalVolume);
      const last = parseFloat(primaryTicker.last);
      const open24 = parseFloat(primaryTicker.open24h);
      const high24 = parseFloat(primaryTicker.high24h);
      const low24 = parseFloat(primaryTicker.low24h);
      // Ensure we have valid numeric values to work with
      if (!open24 || !high24 || !low24 || !last) continue;
      // Calculate the 24h price change (percentage) to determine category (pumping/dumping)
      const priceChange24 = ((last - open24) / open24) * 100;
      const category = priceChange24 >= 0 ? "pumping" : "dumping";
      // Predicted amplitude is the potential move size from open24h to the 24h high (for pumps)
      // or from open24h to the 24h low (for dumps). This approximates how big the move can get.
      let predictedAmplitude = category === "pumping" ? high24 - open24 : open24 - low24;
      // Skip tokens where we cannot determine a positive amplitude
      if (predictedAmplitude <= 0) continue;
      // Completion measures how far along the current move is relative to its predicted amplitude
      const completion = Math.max(
        0,
        Math.min(100, (Math.abs(last - open24) / predictedAmplitude) * 100)
      );
      aggregated.push({
        base,
        totalVolume,
        last,
        open24,
        high24,
        low24,
        priceChange24,
        category,
        completion,
        predictedAmplitude,
      });
    }
    // If no tokens were aggregated from BloFin perpetuals, fall back to a more general
    // algorithm using top market-cap tokens from CoinGecko. This ensures the list
    // is never empty, since the crypto market always has movers. The fallback
    // computes a momentum score based on the 24h price range and volume ratio,
    // similar to the primary algorithm but without the BloFin-specific data.
    if (aggregated.length === 0) {
      try {
        // Fetch up to 200 coins ordered by 24h volume from CoinGecko markets endpoint
        const fallbackPages = 2;
        let markets = [];
        for (let page = 1; page <= fallbackPages; page++) {
          const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=100&page=${page}&sparkline=false&price_change_percentage=1h,24h`;
          const res = await fetch(url);
          if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data)) markets = markets.concat(data);
          }
        }
        // Filter out stablecoins
        const stableSymbols = new Set([
          "usdt",
          "usdc",
          "usd",
          "busd",
          "dai",
          "tusd",
          "pax",
          "usdp",
          "usdk",
          "usdd",
          "eur",
          "jpy",
          "gbp",
        ]);
        // Determine maximum volume for normalization
        let maxVol = 0;
        const fallbackAgg = [];
        for (const info of markets) {
          const symbolLower = info.symbol ? info.symbol.toLowerCase() : "";
          if (stableSymbols.has(symbolLower)) continue;
          const totalVolume = info.total_volume || info.total_volume_usd || 0;
          if (!totalVolume || totalVolume <= 0) continue;
          maxVol = Math.max(maxVol, totalVolume);
          const high24 = info.high_24h;
          const low24 = info.low_24h;
          const price = info.current_price;
          const priceChange24 = info.price_change_percentage_24h_in_currency !== undefined
            ? info.price_change_percentage_24h_in_currency
            : info.price_change_percentage_24h;
          // Determine pumping/dumping based on 24h change
          const category = priceChange24 >= 0 ? "pumping" : "dumping";
          // Estimate predicted amplitude as the 24h trading range
          let amplitude = (high24 !== null && low24 !== null) ? (high24 - low24) : 0;
          if (!amplitude || amplitude <= 0) continue;
          // Estimate completion using 1h price change when available. If not, use 24h change.
          let priceChange1h = 0;
          if (info.price_change_percentage_1h_in_currency !== undefined) {
            priceChange1h = Math.abs(info.price_change_percentage_1h_in_currency);
          } else if (info.price_change_percentage_1h !== undefined) {
            priceChange1h = Math.abs(info.price_change_percentage_1h);
          } else {
            priceChange1h = Math.abs(priceChange24) / 24; // rough approximation
          }
          // Completion as ratio of recent movement to total predicted amplitude (clamped 0-100)
          const completion = Math.max(
            0,
            Math.min(100, (priceChange1h / Math.abs(priceChange24 || 1e-6)) * 100)
          );
          fallbackAgg.push({
            name: info.name,
            symbol: info.symbol ? info.symbol.toUpperCase() : info.id,
            image: info.image || "",
            category,
            completion,
            current_price: price,
            totalVolume: totalVolume,
            priceChange24: priceChange24 || 0,
            amplitude,
          });
        }
        // Compute momentum score for fallback tokens
        fallbackAgg.forEach((token) => {
          const volRatio = maxVol > 0 ? token.totalVolume / maxVol : 0;
          const earlyFactor = 1 - token.completion / 100;
          token.momentumScore = token.amplitude * volRatio * earlyFactor;
        });
        // Sort and highlight top 10%
        fallbackAgg.sort((a, b) => b.momentumScore - a.momentumScore);
        const highlightCt = Math.max(1, Math.round(fallbackAgg.length * 0.1));
        fallbackAgg.forEach((token, idx) => {
          token.highlight = idx < highlightCt;
        });
        // Set tokens and render
        tokens = fallbackAgg;
        filteredTokens = [...tokens];
        if (tokens.length > 0) {
          statusEl.style.display = "none";
          tokensTable.classList.remove("hidden");
          renderTable(filteredTokens);
        } else {
          statusEl.textContent = "No market tokens available.";
        }
        if (scanEl) scanEl.classList.add("hidden");
        return;
      } catch (fallbackErr) {
        console.warn("Fallback fetch failed", fallbackErr);
        statusEl.textContent = "Failed to fetch data. Please check your internet connection or try again later.";
        if (scanEl) scanEl.classList.add("hidden");
        return;
      }
    }
    // Compute momentum score: emphasise high predicted amplitude, significant volume and how early the move is
    // Momentum probability combines the predicted amplitude (potential move size),
    // the relative volume share on BloFin and an early factor indicating how far along the move is.
    aggregated.forEach((token) => {
      const volRatio = maxVolume > 0 ? token.totalVolume / maxVolume : 0;
      const earlyFactor = 1 - token.completion / 100;
      // Multiply predictedAmplitude by volume ratio and early factor to get momentum probability
      token.momentumScore = token.predictedAmplitude * volRatio * earlyFactor;
    });
    // Sort by momentum score descending
    aggregated.sort((a, b) => b.momentumScore - a.momentumScore);
    // Highlight top 10% tokens as clear movers
    const highlightCount = Math.max(1, Math.round(aggregated.length * 0.1));
    aggregated.forEach((token, index) => {
      token.highlight = index < highlightCount;
    });
    // Map base symbols to CoinGecko IDs
    let coinList = [];
    try {
      const listRes = await fetch(
        "https://api.coingecko.com/api/v3/coins/list?include_platform=false"
      );
      if (listRes.ok) {
        coinList = await listRes.json();
      }
    } catch (e) {
      console.warn("Failed to fetch CoinGecko coin list", e);
    }
    const symbolToIds = {};
    coinList.forEach((c) => {
      const sym = c.symbol.toLowerCase();
      if (!symbolToIds[sym]) symbolToIds[sym] = [];
      symbolToIds[sym].push(c.id);
    });
    // Select IDs for aggregated tokens
    const idMap = {};
    const idsToFetch = [];
    aggregated.forEach((token) => {
      const symLower = token.base.toLowerCase();
      const ids = symbolToIds[symLower];
      if (ids && ids.length > 0) {
        // pick the first ID for now; if multiple, will refine later
        const chosenId = ids[0];
        idMap[token.base] = chosenId;
        idsToFetch.push(chosenId);
      }
    });
    // Fetch market data for selected IDs to get names/images/market cap
    let marketInfo = [];
    if (idsToFetch.length > 0) {
      const uniqueIds = Array.from(new Set(idsToFetch)).slice(0, 150);
      const idsParam2 = uniqueIds.join(",");
      try {
        const marketsRes = await fetch(
          `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${idsParam2}&sparkline=false&price_change_percentage=24h`
        );
        if (marketsRes.ok) {
          marketInfo = await marketsRes.json();
        }
      } catch (e) {
        console.warn("Failed to fetch CoinGecko market info", e);
      }
    }
    // Map id to details
    const idDetails = {};
    marketInfo.forEach((info) => {
      idDetails[info.id] = info;
    });
    // Build final token objects with names/images, falling back to symbol if missing
    tokens = aggregated.map((token) => {
      const coinId = idMap[token.base];
      const details = coinId ? idDetails[coinId] : null;
      return {
        name: details ? details.name : token.base,
        symbol: token.base,
        image: details ? details.image : "",
        category: token.category,
        completion: token.completion,
        current_price: token.last,
        totalVolume: token.totalVolume,
        priceChange24: token.priceChange24,
        highlight: token.highlight,
        momentumScore: token.momentumScore,
      };
    });
    filteredTokens = [...tokens];
    if (tokens.length === 0) {
      statusEl.textContent = "No BloFin perpetual tokens available.";
    } else {
      statusEl.style.display = "none";
      tokensTable.classList.remove("hidden");
      renderTable(filteredTokens);
    }
    if (scanEl) scanEl.classList.add("hidden");
  } catch (err) {
    console.error("Error during fetchData:", err);
    statusEl.textContent =
      "Failed to fetch data. Please check your internet connection or try again later.";
    if (scanEl) scanEl.classList.add("hidden");
  }
}

// Render the table with tokens data
function renderTable(list) {
  tokensBody.innerHTML = "";
  list.forEach((token) => {
    const row = document.createElement("tr");
    // Apply highlight style for clear movers
    if (token.highlight) {
      row.classList.add("highlight-row");
    }
    // Name cell with optional image
    const nameCell = document.createElement("td");
    if (token.image) {
      const img = document.createElement("img");
      img.src = token.image;
      img.alt = `${token.name} logo`;
      img.width = 24;
      img.height = 24;
      img.style.verticalAlign = "middle";
      img.style.marginRight = "8px";
      nameCell.appendChild(img);
    }
    const nameSpan = document.createElement("span");
    nameSpan.textContent = token.name;
    nameCell.appendChild(nameSpan);
    row.appendChild(nameCell);
    // Symbol cell
    const symbolCell = document.createElement("td");
    symbolCell.textContent = token.symbol.toUpperCase();
    row.appendChild(symbolCell);
    // Category cell
    const catCell = document.createElement("td");
    const catLabel = token.category ? token.category.charAt(0).toUpperCase() + token.category.slice(1) : "Neutral";
    catCell.textContent = catLabel;
    if (token.category === "pumping") catCell.style.color = "#00ff99";
    else if (token.category === "dumping") catCell.style.color = "#ff4444";
    else catCell.style.color = "#cccccc";
    row.appendChild(catCell);
    // Completion cell
    const completionCell = document.createElement("td");
    completionCell.classList.add("numeric");
    const comp = token.completion ? token.completion.toFixed(1) : "0.0";
    completionCell.textContent = `${comp}%`;
    const compValue = parseFloat(comp);
    if (token.category === "pumping") {
      if (compValue >= 80) completionCell.style.color = "#00ff00";
      else if (compValue >= 50) completionCell.style.color = "#66ff66";
      else if (compValue >= 20) completionCell.style.color = "#99ff99";
      else completionCell.style.color = "#cccccc";
    } else if (token.category === "dumping") {
      if (compValue >= 80) completionCell.style.color = "#ff0000";
      else if (compValue >= 50) completionCell.style.color = "#ff3333";
      else if (compValue >= 20) completionCell.style.color = "#ff6666";
      else completionCell.style.color = "#cccccc";
    } else {
      completionCell.style.color = "#cccccc";
    }
    row.appendChild(completionCell);
    // Price cell
    const priceCell = document.createElement("td");
    priceCell.classList.add("numeric");
    priceCell.textContent = `$${Number(token.current_price).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
    row.appendChild(priceCell);
    // Volume cell
    const volCell = document.createElement("td");
    volCell.classList.add("numeric");
    volCell.textContent = `$${formatNumber(token.totalVolume)}`;
    row.appendChild(volCell);
    // 24h Change cell
    const change24Cell = document.createElement("td");
    change24Cell.classList.add("numeric");
    const chg = token.priceChange24;
    change24Cell.textContent = `${chg.toFixed(2)}%`;
    change24Cell.style.color = chg >= 0 ? "#00ff99" : "#ff4444";
    row.appendChild(change24Cell);
    tokensBody.appendChild(row);
  });
}

// Filter tokens based on search input
function filterTokens() {
  const query = searchInput.value.trim().toLowerCase();
  if (!query) {
    filteredTokens = [...tokens];
  } else {
    filteredTokens = tokens.filter(
      (token) =>
        token.name.toLowerCase().includes(query) ||
        token.symbol.toLowerCase().includes(query)
    );
  }
  if (filteredTokens.length === 0) {
    statusEl.textContent = "No tokens found matching your search.";
    statusEl.style.display = "block";
    tokensTable.classList.add("hidden");
  } else {
    statusEl.style.display = "none";
    tokensTable.classList.remove("hidden");
    renderTable(filteredTokens);
  }
}

// Event listeners
refreshButton.addEventListener("click", () => {
  fetchData();
});
searchInput.addEventListener("input", () => {
  filterTokens();
});

// Initial fetch on load
document.addEventListener("DOMContentLoaded", () => {
  fetchData();
});