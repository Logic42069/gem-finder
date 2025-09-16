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

// Fetch market and trending data from CoinGecko, compute a momentum score, and rank tokens.
async function fetchData() {
  statusEl.textContent = "Fetching data...";
  statusEl.style.display = "block";
  tokensTable.classList.add("hidden");
  // Show scanning animation
  if (scanEl) {
    scanEl.classList.remove("hidden");
  }
  try {
    const pagesToFetch = 3; // number of pages (each page = 250 tokens)
    const perPage = 250;
    const pageNumbers = Array.from({ length: pagesToFetch }, (_, i) => i + 1);
    // Build requests for each page ordered by 24h volume desc. We'll wrap each fetch in a try/catch so one failing page doesn't abort the entire process.
    const pagePromises = pageNumbers.map((page) => {
      return fetch(
        `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=${perPage}&page=${page}&sparkline=false&price_change_percentage=24h`
      ).catch(() => null);
    });
    // Fetch trending search coins with graceful error handling
    const trendingPromise = fetch(
      "https://api.coingecko.com/api/v3/search/trending"
    ).catch(() => null);
    // Await all responses. Use Promise.allSettled to avoid rejecting if one fails
    const responses = await Promise.all([...pagePromises, trendingPromise]);
    // Extract JSON bodies for market pages that returned successfully
    const dataResults = [];
    for (let i = 0; i < pagesToFetch; i++) {
      const res = responses[i];
      if (res && res.ok) {
        try {
          const json = await res.json();
          dataResults.push(json);
        } catch (e) {
          console.warn('Failed to parse page', i + 1, e);
        }
      } else {
        console.warn('Skipping page', i + 1, 'due to network error');
      }
    }
    // Flatten market data. If no pages succeeded, set an empty array
    let data = [];
    if (dataResults.length > 0) {
      data = dataResults.flat();
    }
    // Handle trending search data
    let trendingItems = [];
    const trendingRes = responses[pagesToFetch];
    if (trendingRes && trendingRes.ok) {
      try {
        const trendingJson = await trendingRes.json();
        if (Array.isArray(trendingJson.coins)) {
          trendingItems = trendingJson.coins.map((c) => c.item);
        }
      } catch (e) {
        console.warn('Failed to parse trending data', e);
      }
    } else {
      // If trending request failed, we simply skip adding trending coins
      console.warn('Trending request failed or returned non-OK response');
    }
    let trendingMarketData = [];
    if (trendingItems.length > 0) {
      const trendingIds = trendingItems.map((item) => item.id).join(",");
      try {
        const trendingMarketRes = await fetch(
          `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${trendingIds}&sparkline=false&price_change_percentage=24h`
        );
        if (trendingMarketRes.ok) {
          trendingMarketData = await trendingMarketRes.json();
        }
      } catch (e) {
        console.warn('Failed to fetch trending market data', e);
      }
    }
    // Merge trending data into market data, marking trending coins
    const byId = new Map();
    data.forEach((token) => {
      token.isTrending = false;
      byId.set(token.id, token);
    });
    trendingMarketData.forEach((t) => {
      if (byId.has(t.id)) {
        byId.get(t.id).isTrending = true;
      } else {
        t.isTrending = true;
        data.push(t);
        byId.set(t.id, t);
      }
    });
    // Compute a momentum score: price change * volume/market_cap (avoid division by zero)
    data.forEach((token) => {
      const priceChange =
        typeof token.price_change_percentage_24h === "number"
          ? token.price_change_percentage_24h
          : 0;
      const volumeRatio =
        token.market_cap && token.market_cap > 0
          ? token.total_volume / token.market_cap
          : 0;
      token.score = priceChange * volumeRatio;
    });
    // Filter out tokens with minimal activity (price change <= 0 or volume <= 0)
    const filtered = data.filter(
      (token) =>
        token.total_volume > 0 && typeof token.score === "number" && token.score > 0
    );
    // Sort by score descending
    filtered.sort((a, b) => b.score - a.score);
    // Take top 100 tokens to display
    const topTokens = filtered.slice(0, 100);
    tokens = topTokens;
    filteredTokens = [...tokens];
    if (tokens.length === 0) {
      statusEl.textContent =
        "No tokens found with significant momentum. Try again later.";
    } else {
      // Compute max score to normalize probabilities
      const maxScore = tokens[0].score || 0;
      tokens.forEach((token) => {
        token.probability = maxScore > 0 ? token.score / maxScore : 0;
      });
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
    // Price
    const priceCell = document.createElement("td");
    priceCell.classList.add("numeric");
    priceCell.textContent = `$${Number(token.current_price).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
    row.appendChild(priceCell);
    // Volume
    const volumeCell = document.createElement("td");
    volumeCell.classList.add("numeric");
    volumeCell.textContent = `$${formatNumber(token.total_volume)}`;
    row.appendChild(volumeCell);
    // 24h Change
    const changeCell = document.createElement("td");
    changeCell.classList.add("numeric");
    const change = token.price_change_percentage_24h;
    changeCell.textContent = `${change.toFixed(2)}%`;
    changeCell.style.color = change >= 0 ? "#00ff99" : "#ff4444";
    row.appendChild(changeCell);
    // Market Cap
    const capCell = document.createElement("td");
    capCell.classList.add("numeric");
    capCell.textContent = `$${formatNumber(token.market_cap)}`;
    row.appendChild(capCell);

    // Moon Probability
    const probCell = document.createElement("td");
    probCell.classList.add("numeric");
    const probPercent = token.probability ? (token.probability * 100).toFixed(1) : 0;
    probCell.textContent = `${probPercent}%`;
    // Color-code probability: greener for higher probability
    const probValue = parseFloat(probPercent);
    if (probValue >= 80) {
      probCell.style.color = "#00ff00";
    } else if (probValue >= 50) {
      probCell.style.color = "#66ff66";
    } else if (probValue >= 20) {
      probCell.style.color = "#99ff99";
    } else {
      probCell.style.color = "#cccccc";
    }
    row.appendChild(probCell);
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