/*
 * Gem Finder - client-side logic
 *
 * This script fetches market data from CoinGecko, filters tokens that have
 * increased at least 100% over the last 24 hours (2x), and ranks them by
 * 24h trading volume. It also provides a simple search function and
 * interactive refresh.
 */

// Global state for tokens data
let tokens = [];
let filteredTokens = [];

// DOM elements
const tokensTable = document.getElementById("tokens-table");
const tokensBody = document.getElementById("tokens-body");
const searchInput = document.getElementById("search-input");
const refreshButton = document.getElementById("refresh-button");
const statusEl = document.getElementById("status");

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

// Fetch data from CoinGecko
async function fetchData() {
  statusEl.textContent = "Fetching data...";
  statusEl.style.display = "block";
  tokensTable.classList.add("hidden");
  try {
    const endpoint =
      "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&price_change_percentage=24h";
    const response = await fetch(endpoint);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    // Filter for tokens with price change >= 100% (2x) and non-zero volume
    tokens = data.filter(
      (token) =>
        typeof token.price_change_percentage_24h === "number" &&
        token.price_change_percentage_24h >= 100 &&
        token.total_volume > 0
    );
    // Sort by 24h volume descending (higher volume first)
    tokens.sort((a, b) => b.total_volume - a.total_volume);
    filteredTokens = [...tokens];
    if (tokens.length === 0) {
      statusEl.textContent =
        "No tokens found with 2x growth in the last 24 hours. Try again later.";
    } else {
      statusEl.style.display = "none";
      tokensTable.classList.remove("hidden");
      renderTable(filteredTokens);
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
    // Name column with coin image and name
    const nameCell = document.createElement("td");
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
