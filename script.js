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

// Fetch BloFin tickers and market data to build a volume‑focused ranking.
async function fetchData() {
  statusEl.textContent = "Fetching data...";
  statusEl.style.display = "block";
  tokensTable.classList.add("hidden");
  // Show scanning animation
  if (scanEl) {
    scanEl.classList.remove("hidden");
  }
  try {
    // Step 1: fetch BloFin spot tickers to determine which tokens are available and their volumes
    let tickersData = [];
    try {
      const tickersRes = await fetch(
        "https://api.coingecko.com/api/v3/exchanges/blofin_spot/tickers"
      );
      if (tickersRes.ok) {
        const json = await tickersRes.json();
        if (Array.isArray(json.tickers)) {
          tickersData = json.tickers;
        }
      } else {
        console.warn("BloFin tickers request returned non-OK response");
      }
    } catch (e) {
      console.warn("Failed to fetch BloFin tickers", e);
    }
    // Build a map of coin_id to total BloFin volume (USD) and base symbol
    const volumeMap = {};
    tickersData.forEach((ticker) => {
      // Exclude if no coin_id or no converted volume
      const id = ticker.coin_id;
      const volumeUsd =
        ticker.converted_volume && ticker.converted_volume.usd
          ? Number(ticker.converted_volume.usd)
          : 0;
      if (!id || !volumeUsd || isNaN(volumeUsd)) return;
      if (!volumeMap[id]) {
        volumeMap[id] = { volume: 0, base: ticker.base };
      }
      volumeMap[id].volume += volumeUsd;
    });
    // Exclude known stablecoins and tokens with zero volume
    const stableIds = new Set([
      // Known stablecoin identifiers to exclude
      "tether",
      "usd-coin",
      "binance-usd",
      "pax-dollar",
      "dai",
      "true-usd",
      "frax",
      "usdd",
      "usdp",
      "usdk",
      "mimatic",
      "fei-usd",
      "gusd",
      "harmony-usd",
      "tusd",
      "husd",
      "lusd"
    ]);
    // Extract entries and filter out stable coins and zero volumes
    let entries = Object.entries(volumeMap).filter(([, info]) => info.volume > 0);
    entries = entries.filter(([id]) => !stableIds.has(id));
    // Sort by volume descending and take top 100
    entries.sort((a, b) => b[1].volume - a[1].volume);
    const topEntries = entries.slice(0, 100);
    const coinIds = topEntries.map(([id]) => id);
    if (coinIds.length === 0) {
      statusEl.textContent =
        "No BloFin‑listed tokens with volume data available. Try again later.";
      // Hide scanning animation
      if (scanEl) scanEl.classList.add("hidden");
      return;
    }
    // Step 2: fetch market data for these coin IDs
    const idsParam = coinIds.join(",");
    let marketData = [];
    try {
      const marketsRes = await fetch(
        `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${idsParam}&sparkline=false&price_change_percentage=1h%2C24h`
      );
      if (marketsRes.ok) {
        marketData = await marketsRes.json();
      } else {
        console.warn("Market data request returned non-OK response");
      }
    } catch (e) {
      console.warn("Failed to fetch market data", e);
    }
    // Step 3: fetch trending search data to highlight popular coins (optional)
    let trendingItems = [];
    try {
      const trendingRes = await fetch(
        "https://api.coingecko.com/api/v3/search/trending"
      );
      if (trendingRes.ok) {
        const trendingJson = await trendingRes.json();
        if (Array.isArray(trendingJson.coins)) {
          trendingItems = trendingJson.coins.map((c) => c.item);
        }
      }
    } catch (e) {
      console.warn("Failed to fetch trending data", e);
    }
    // Build a set of trending IDs for quick lookup
    const trendingSet = new Set(trendingItems.map((item) => item.id));
    // Combine market data with volume info and compute metrics
    const resultTokens = [];
    marketData.forEach((token) => {
      const id = token.id;
      const volumeInfo = volumeMap[id];
      if (!volumeInfo) return;
      const blofinVolume = volumeInfo.volume;
      // 1h and 24h price changes
      const priceChange1h =
        typeof token.price_change_percentage_1h_in_currency === "number"
          ? token.price_change_percentage_1h_in_currency
          : typeof token.price_change_percentage_1h === "number"
          ? token.price_change_percentage_1h
          : 0;
      const priceChange24h =
        typeof token.price_change_percentage_24h === "number"
          ? token.price_change_percentage_24h
          : 0;
      // Exclude tokens with tiny 24h moves to remove stablecoins
      if (Math.abs(priceChange24h) < 0.5) return;
      // Compute BloFin share of total volume (percentage) and volume ratio relative to market cap
      const totalVol = token.total_volume || 0;
      const marketCap = token.market_cap || 0;
      const blofinShare = totalVol > 0 ? (blofinVolume / totalVol) * 100 : 0;
      const volumeRatio = marketCap > 0 ? blofinVolume / marketCap : 0;
      // Category based on 1h change (pumping or dumping)
      let category = "neutral";
      if (priceChange1h > 0) category = "pumping";
      else if (priceChange1h < 0) category = "dumping";
      // Predict the potential magnitude of the move using 24h change and BloFin volume share.
      // The predicted amplitude grows as the 24h change grows and BloFin share increases.
      const predictedAmplitude = Math.abs(priceChange24h) * (1 + blofinShare / 50);
      // Completion reflects how much of this predicted move has already occurred based on the 1h change.
      let completion = 0;
      if (predictedAmplitude > 0) {
        completion = (Math.abs(priceChange1h) / predictedAmplitude) * 100;
      }
      // Clamp to 0–100
      completion = Math.max(0, Math.min(100, completion));
      resultTokens.push({
        ...token,
        isTrending: trendingSet.has(token.id),
        category,
        completion,
        blofinVolume,
        blofinShare,
        volumeRatio,
        priceChange1h,
        priceChange24h,
      });
    });
    // Sort by blofinShare descending to surface tokens with high BloFin volume share
    resultTokens.sort((a, b) => b.blofinShare - a.blofinShare);
    // Keep top 100 tokens
    tokens = resultTokens.slice(0, 100);
    filteredTokens = [...tokens];
    if (tokens.length === 0) {
      statusEl.textContent =
        "No BloFin‑listed tokens with sufficient volume found. Try again later.";
    } else {
      statusEl.style.display = "none";
      tokensTable.classList.remove("hidden");
      renderTable(filteredTokens);
    }
    // Hide scanning animation
    if (scanEl) {
      scanEl.classList.add("hidden");
    }
  } catch (error) {
    console.error("Error fetching data:", error);
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
    // Name column with coin image and name (and optional trending star)
    const nameCell = document.createElement("td");
    // Add a star for trending tokens
    if (token.isTrending) {
      const star = document.createElement("span");
      star.textContent = "★ ";
      // Use accent color from CSS variables if available
      const accentColor = getComputedStyle(document.documentElement).getPropertyValue('--accent-color').trim();
      star.style.color = accentColor || "#00cc66";
      nameCell.appendChild(star);
    }
    const img = document.createElement("img");
    img.src = token.image;
    img.alt = `${token.name} logo`;
    img.width = 24;
    img.height = 24;
    img.style.verticalAlign = "middle";
    img.style.marginRight = "8px";
    nameCell.appendChild(img);
    const nameText = document.createElement("span");
    nameText.textContent = token.name;
    nameCell.appendChild(nameText);
    row.appendChild(nameCell);
    // Symbol
    const symbolCell = document.createElement("td");
    symbolCell.textContent = token.symbol.toUpperCase();
    row.appendChild(symbolCell);
    // Category (pumping, dumping, neutral)
    const catCell = document.createElement("td");
    let catLabel = token.category ? token.category.charAt(0).toUpperCase() + token.category.slice(1) : "Neutral";
    catCell.textContent = catLabel;
    // Set category color: green for pumping, red for dumping, gray for neutral
    if (token.category === "pumping") {
      catCell.style.color = "#00ff99";
    } else if (token.category === "dumping") {
      catCell.style.color = "#ff4444";
    } else {
      catCell.style.color = "#cccccc";
    }
    row.appendChild(catCell);
    // Completion percentage
    const completionCell = document.createElement("td");
    completionCell.classList.add("numeric");
    const compPercent = token.completion ? token.completion.toFixed(1) : 0;
    completionCell.textContent = `${compPercent}%`;
    // Color-code completion: if pumping, greener as it approaches 100%; if dumping, redder as it approaches 100%
    const compValue = parseFloat(compPercent);
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
    // Price
    const priceCell = document.createElement("td");
    priceCell.classList.add("numeric");
    priceCell.textContent = `$${Number(token.current_price).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
    row.appendChild(priceCell);
    // BloFin Volume
    const volumeCell = document.createElement("td");
    volumeCell.classList.add("numeric");
    volumeCell.textContent = `$${formatNumber(token.blofinVolume)}`;
    row.appendChild(volumeCell);
    // BloFin Share
    const shareCell = document.createElement("td");
    shareCell.classList.add("numeric");
    const share = token.blofinShare || 0;
    shareCell.textContent = `${share.toFixed(2)}%`;
    // Color-code share: highlight high share values
    if (share >= 50) shareCell.style.color = "#00ff00";
    else if (share >= 20) shareCell.style.color = "#66ff66";
    else if (share >= 5) shareCell.style.color = "#99ff99";
    else shareCell.style.color = "#cccccc";
    row.appendChild(shareCell);
    // 1h Change
    const change1Cell = document.createElement("td");
    change1Cell.classList.add("numeric");
    const change1 = token.priceChange1h;
    change1Cell.textContent = `${change1.toFixed(2)}%`;
    change1Cell.style.color = change1 >= 0 ? "#00ff99" : "#ff4444";
    row.appendChild(change1Cell);
    // 24h Change
    const changeCell = document.createElement("td");
    changeCell.classList.add("numeric");
    const change = token.priceChange24h;
    changeCell.textContent = `${change.toFixed(2)}%`;
    changeCell.style.color = change >= 0 ? "#00ff99" : "#ff4444";
    row.appendChild(changeCell);
    // Market Cap
    const capCell = document.createElement("td");
    capCell.classList.add("numeric");
    capCell.textContent = `$${formatNumber(token.market_cap)}`;
    row.appendChild(capCell);
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