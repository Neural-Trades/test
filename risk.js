const axios = require('axios');
const { Connection, PublicKey } = require('@solana/web3.js');

// Configuration for Solana connection
const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");

// Configuration for Birdeye API
const BIRDEYE_API_KEY = '36171fdeea724bdd9b7e071f61ef2e2a'; // Replace with your actual API key
const birdeyeHeaders = {
  'X-API-KEY': BIRDEYE_API_KEY,
  'accept': 'application/json'
};

// Cache to store external data
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Helper function to fetch Birdeye data with caching
async function fetchCachedBirdeyeData(endpoint, params) {
  const key = JSON.stringify({ endpoint, params });
  const cached = cache.get(key);
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) return cached.data;
  const data = await fetchBirdeyeData(endpoint, params);
  cache.set(key, { data, timestamp: Date.now() });
  return data;
}

// Fetch data from Birdeye API
async function fetchBirdeyeData(endpoint, params) {
  try {
    const url = `https://public-api.birdeye.so${endpoint}?${new URLSearchParams(params)}`;
    const response = await axios.get(url, { headers: birdeyeHeaders });
    return response.data.data || {};
  } catch (error) {
    console.error(`❌ Error fetching Birdeye data for ${endpoint}:`, error.message);
    return {};
  }
}

// Check token contract authorities with retry mechanism
async function checkTokenContractWithRetry(mintAddress, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const tokenAccount = await connection.getParsedAccountInfo(new PublicKey(mintAddress));
      if (!tokenAccount?.value || !(tokenAccount.value.data instanceof Object)) {
        return { isValid: false, reason: "Invalid token or unparsed data" };
      }
      const tokenData = tokenAccount.value.data.parsed?.info || {};
      const mintAuthority = tokenData.mintAuthority;
      const freezeAuthority = tokenData.freezeAuthority;
      if (mintAuthority) return { isValid: false, reason: "Mint Authority active" };
      if (freezeAuthority) return { isValid: false, reason: "Freeze Authority active" };
      return { isValid: true };
    } catch (error) {
      if (attempt === maxAttempts) return { isValid: false, reason: "Error checking contract" };
      await new Promise(res => setTimeout(res, 1000 * attempt));
    }
  }
}

// Validate Mint Address
function isValidMintAddress(address) {
  try {
    new PublicKey(address);
    return true;
  } catch (error) {
    return false;
  }
}

// Calculate token age in hours
async function getTokenAgeInHours(mintAddress) {
  const tokenOverview = await fetchCachedBirdeyeData('/defi/token_overview', { address: mintAddress });
  if (tokenOverview && tokenOverview.pairCreatedAt) {
    const creationDate = new Date(tokenOverview.pairCreatedAt);
    const currentDate = new Date();
    return (currentDate - creationDate) / (1000 * 60 * 60); // Convert to hours
  }
  return null;
}

// Check if token has already experienced a rug pull
async function checkRugPull(mintAddress) {
  const tokenSecurity = await fetchCachedBirdeyeData('/defi/token_security', { address: mintAddress });
  if (tokenSecurity && tokenSecurity.isRugPullDetected) {
    return {
      rugPull: true,
      message: "This token has already experienced a rug pull. Should have used Rug Sniffer earlier, huh?"
    };
  }
  return { rugPull: false };
}

// **1. Liquidity and Security Risk**
async function getLiquiditySecurityRisk(mintAddress) {
  let risk = 0;
  let negatives = [];
  const tokenOverview = await fetchCachedBirdeyeData('/defi/token_overview', { address: mintAddress });
  const liquidityHistory = await fetchBirdeyeData('/defi/history_liquidity', { address: mintAddress, time_from: 'now-6h', time_to: 'now' });

  if (tokenOverview) {
    const liquidity = tokenOverview.liquidity?.usd || 0;
    if (liquidity < 10000) {
      risk += 30;
      negatives.push("Very low liquidity (<$10K)");
    }
    if (!tokenOverview.liquidityLocked) {
      risk += 25;
      negatives.push("Liquidity not locked");
    }
  }

  if (liquidityHistory) {
    const drop1h = liquidityHistory.drop1h || 0;
    if (drop1h > 50) {
      risk += 35;
      negatives.push("Liquidity dropped more than 50% in less than 1h");
    }
    if (liquidityHistory.multiplePoolsDetected) {
      risk += 20;
      negatives.push("Multiple liquidity pools created");
    }
    if (liquidityHistory.deployerActivity?.rapidAddRemove) {
      risk += 30;
      negatives.push("Deployer rapidly adds and removes liquidity");
    }
  }
  return { risk, negatives };
}

// **2. Honeypot Risk**
async function getHoneypotRisk(mintAddress) {
  let risk = 0;
  let negatives = [];
  const tokenSecurity = await fetchCachedBirdeyeData('/defi/token_security', { address: mintAddress });
  const walletActivity = await fetchBirdeyeData('/defi/wallet_activity', { address: mintAddress, time_from: 'now-6h', time_to: 'now' });

  if (tokenSecurity) {
    if (tokenSecurity.isHoneypot) {
      risk += 30;
      negatives.push("Multiple failed sell transactions (honeypot)");
    }
    if (tokenSecurity.sellFee > 10) {
      risk += 20;
      negatives.push("Sell fee higher than 10%");
    }
    if (tokenSecurity.dynamicSellFee) {
      risk += 30;
      negatives.push("Dynamic sell fee increases over time");
    }
  }

  if (walletActivity) {
    if (walletActivity.slippageIncrease > 25) {
      risk += 25;
      negatives.push("Dynamic slippage increasing rapidly");
    }
    if (walletActivity.successfulSellsPercentage < 5) {
      risk += 20;
      negatives.push("Only certain wallets can sell (<5%)");
    }
    if (walletActivity.limitedSellAmounts) {
      risk += 15;
      negatives.push("Sales limited to small amounts");
    }
  }
  return { risk, negatives };
}

// **3. Farming and Sybil Attack Risk**
async function getFarmingSybilRisk(mintAddress) {
  let risk = 0;
  let negatives = [];
  const walletActivity = await fetchBirdeyeData('/defi/wallet_activity', { address: mintAddress, time_from: 'now-6h', time_to: 'now' });

  if (walletActivity) {
    if (walletActivity.identicalBuys > 5) {
      risk += 20;
      negatives.push("Multiple wallets buying exact same amount within seconds");
    }
    if (walletActivity.newWalletBuysPercentage > 50) {
      risk += 15;
      negatives.push("New wallets (<7 days) buying large amounts");
    }
    if (walletActivity.distributionToMultipleWallets) {
      risk += 25;
      negatives.push("Wallets buying and distributing tokens to multiple wallets");
    }
    if (walletActivity.holdersNoSellsAfter6h) {
      risk += 10;
      negatives.push("Farming holders not selling after 6h");
    }
    if (walletActivity.consolidationToSingleAddress) {
      risk += 30;
      negatives.push("Many wallets sending tokens to a single address after 6h");
    }
  }
  return { risk, negatives };
}

// **4. Holder and Distribution Risk**
async function getHolderDistributionRisk(mintAddress) {
  let risk = 0;
  let negatives = [];
  const holderData = await fetchBirdeyeData('/defi/holder_data', { address: mintAddress, time_from: 'now-6h', time_to: 'now' });

  if (holderData) {
    if (holderData.count < 100 && holderData.ageHours > 1) {
      risk += 20;
      negatives.push("Less than 100 holders after 1 hour of launch");
    }
    if (holderData.top5Percentage > 50) {
      risk += 15;
      negatives.push("Top 5 wallets hold >50% of tokens");
    }
    if (holderData.newWalletPercentage > 50) {
      risk += 15;
      negatives.push("Majority of tokens in new wallets (<7 days)");
    }
    if (holderData.massAirdropDetected) {
      risk += 20;
      negatives.push("Tokens distributed to hundreds of small wallets in minutes");
    }
  }
  return { risk, negatives };
}

// **5. Price and Volume Risk**
async function getPriceVolumeRisk(mintAddress) {
  let risk = 0;
  let negatives = [];
  const tokenOverview = await fetchCachedBirdeyeData('/defi/token_overview', { address: mintAddress });
  const priceHistory = await fetchBirdeyeData('/defi/history_price', { address: mintAddress, time_from: 'now-6h', time_to: 'now' });

  if (priceHistory) {
    if (priceHistory.priceChange?.m15 > 500) {
      risk += 30;
      negatives.push("Price pump of +500% in less than 15 minutes");
    }
    if (priceHistory.priceChange?.h1 < -80) {
      risk += 35;
      negatives.push("Price dump of -80% in less than 1 hour");
    }
    if (priceHistory.volumeToLiquidityRatio1h > 10) {
      risk += 10;
      negatives.push("Detected wash trading (volume 10x greater than liquidity in 1h)");
    }
    if (priceHistory.stableDuration < 3) {
      risk += 30;
      negatives.push("Token stable for less than 3 minutes before a pump");
    }
  }

  if (tokenOverview && tokenOverview.successfulSellsPercentage < 5) {
    risk += 15;
    negatives.push("Less than 5% of holders have sold in the first 6 hours");
  }
  return { risk, negatives };
}

// **6. Contract Security Risk**
async function getContractSecurityRisk(mintAddress) {
  let risk = 0;
  let negatives = [];
  const tokenSecurity = await fetchCachedBirdeyeData('/defi/token_security', { address: mintAddress });
  const walletActivity = await fetchBirdeyeData('/defi/wallet_activity', { address: mintAddress, time_from: 'now-6h', time_to: 'now' });

  if (tokenSecurity) {
    if (!tokenSecurity.isVerified) {
      risk += 10;
      negatives.push("Contract not publicly verified");
    }
    if (tokenSecurity.hasSuspiciousPermissions) {
      risk += 20;
      negatives.push("Suspicious permissions (infinite mint, adjustable fees)");
    }
    if (tokenSecurity.isUpgradable) {
      risk += 25;
      negatives.push("Contract is upgradable and allows post-launch modifications");
    }
    if (tokenSecurity.contractUpdatedIn15m) {
      risk += 25;
      negatives.push("Contract was updated within the first 15 minutes");
    }
  }

  if (walletActivity) {
    if (walletActivity.deployerSoldIn6h) {
      risk += 30;
      negatives.push("Developer sold tokens within the first 6 hours");
    }
    if (walletActivity.deployerDistributedTokens) {
      risk += 25;
      negatives.push("Deployer moved tokens to multiple wallets in the first minutes");
    }
  }
  return { risk, negatives };
}

// Calculate final risk score
async function calculateRiskScore(mintAddress) {
  if (!isValidMintAddress(mintAddress)) {
    return { riskScore: 80, negatives: ["Invalid Mint Address"] };
  }

  const [
    liquiditySecurity,
    honeypot,
    farmingSybil,
    holderDistribution,
    priceVolume,
    contractSecurity
  ] = await Promise.all([
    getLiquiditySecurityRisk(mintAddress),
    getHoneypotRisk(mintAddress),
    getFarmingSybilRisk(mintAddress),
    getHolderDistributionRisk(mintAddress),
    getPriceVolumeRisk(mintAddress),
    getContractSecurityRisk(mintAddress)
  ]);

  let riskScore = 0;
  let negatives = [];
  riskScore += liquiditySecurity.risk * 0.20;
  negatives = negatives.concat(liquiditySecurity.negatives);
  riskScore += honeypot.risk * 0.20;
  negatives = negatives.concat(honeypot.negatives);
  riskScore += farmingSybil.risk * 0.15;
  negatives = negatives.concat(farmingSybil.negatives);
  riskScore += holderDistribution.risk * 0.15;
  negatives = negatives.concat(holderDistribution.negatives);
  riskScore += priceVolume.risk * 0.15;
  negatives = negatives.concat(priceVolume.negatives);
  riskScore += contractSecurity.risk * 0.15;
  negatives = negatives.concat(contractSecurity.negatives);

  return { riskScore: Math.min(100, Math.round(riskScore)), negatives };
}

// Main risk analysis function
async function analyzeTokenRisk(walletTokens) {
  const riskAnalysis = [];
  for (const token of walletTokens) {
    const ageInHours = await getTokenAgeInHours(token.mintAddress);
    if (ageInHours && ageInHours > 48) {
      riskAnalysis.push({
        ...token,
        riskScore: null,
        riskLevel: "Unknown",
        riskJustification: "This token has been around for a while (>48h), we do not recommend any specific action.",
        negatives: []
      });
      continue;
    }

    const rugPullCheck = await checkRugPull(token.mintAddress);
    if (rugPullCheck.rugPull) {
      riskAnalysis.push({
        ...token,
        riskScore: null,
        riskLevel: "Rug Pull",
        riskJustification: rugPullCheck.message,
        negatives: []
      });
      continue;
    }

    const { riskScore, negatives } = await calculateRiskScore(token.mintAddress);
    let riskLevel = "Low";
    let justification = "Low Risk - Favorable analysis";
    if (riskScore >= 70) {
      riskLevel = "High";
      justification = "High Risk - Potential scam or rug pull";
    } else if (riskScore >= 40) {
      riskLevel = "Medium";
      justification = "Medium Risk - Suspicious patterns detected";
    }
    riskAnalysis.push({
      ...token,
      riskScore,
      riskLevel,
      riskJustification: justification,
      negatives
    });
  }
  return riskAnalysis;
}

// Format risk analysis message
function formatTokenRiskAnalysis(tokenAnalysis) {
  if (!tokenAnalysis || !tokenAnalysis.mintAddress) {
    return "⚠️ Error: Invalid token analysis data.";
  }
  if (tokenAnalysis.riskScore === null) {
    return `⚠️ Analysis not applicable: ${tokenAnalysis.riskJustification}\n[View on Birdeye](https://birdeye.so/token/${tokenAnalysis.mintAddress})`;
  }
  const riskEmoji = getRiskColorEmoji(tokenAnalysis.riskScore);
  const recommendation = getRiskRecommendation(tokenAnalysis.riskScore);
  let output = `${riskEmoji} 📊 Risk Score: ${tokenAnalysis.riskScore}%\n${recommendation}\n`;
  if (tokenAnalysis.negatives.length > 0) {
    output += "⚠️ Negative Points:\n- " + tokenAnalysis.negatives.join("\n- ") + "\n";
  }
  output += `[View on Birdeye](https://birdeye.so/token/${tokenAnalysis.mintAddress})`;
  return output;
}

// Get risk color emoji
function getRiskColorEmoji(riskScore) {
  if (riskScore <= 15) return '🟢';
  else if (riskScore <= 30) return '🟡';
  else if (riskScore <= 50) return '🟠';
  else if (riskScore <= 75) return '🔴';
  else return '⚫️';
}

// Get recommendation based on risk
function getRiskRecommendation(riskScore) {
  if (riskScore >= 70) return "⚠️ Consider selling immediately!";
  if (riskScore >= 40) return "🟡 Monitor closely.";
  return "🟢 Safe for now.";
}

// Export functions for compatibility
module.exports = {
  analyzeTokenRisk,
  calculateRiskScore,
  isValidMintAddress,
  formatTokenRiskAnalysis,
  getRiskColorEmoji
};
