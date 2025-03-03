const TelegramBot = require('node-telegram-bot-api');
const { Connection, PublicKey, Keypair } = require("@solana/web3.js");
const { Metaplex, bundlrStorage } = require("@metaplex-foundation/js");
const axios = require('axios');
const { Client } = require('pg');
const { 
    analyzeTokenRisk, 
    calculateRiskScore, 
    formatTokenRiskAnalysis, 
    getRiskColorEmoji 
} = require('./risk');
const watchlistModule = require('./watchlist');
const membershipModule = require("./membership");
const utilsModule = require("./utils");

const { 
    handleWatchlistCommand, 
    handleWatchlistAddCommand, 
    handleRemoveWatchlistTokenRequestCallback, 
    handleRemoveTokenCallback, 
    getUserWatchlist, 
    addUserWatchlistToken, 
    removeUserWatchlistToken, 
    getUserWatchlistTokenCount, 
    handleUserInput, 
    isAwaitingMintAddressForWatchlist, 
    clearChat: clearWatchlistChat,
    exportWatchlistToCSV,
    isValidMintAddress 
} = watchlistModule;
const { pendingPayments } = utilsModule;
const { 
    handleMembershipCommand, 
    handleSolPayment, 
    handlePaymentConfirmation, 
    generateSolanaPayLink, 
    listenForSolanaPayment, 
    checkSolTransaction, 
    processReferralInput, 
    updateUserMembership,
    getMembershipInfo 
} = membershipModule;

const isAwaitingConfirmation = {};
const isAwaitingReferral = {};
const isAwaitingTxId = {};
const messageHistory = {};
const isAwaitingMintAddress = {};
const initialMenuMessageIds = {};
const isAwaitingWalletAddress = {};

const token = '7325886083:AAG2Rkk4lwHGxxhW0m2qofUwjIB0ZbwsWWc';
const birdeyeApiKey = '36171fdeea724bdd9b7e071f61ef2e2a';
const connection = new Connection("https://api.mainnet-beta.solana.com");

const metaplex = Metaplex.make(connection).use(bundlrStorage());

const dbClient = new Client({
    user: 'bot_user',
    host: 'localhost',
    database: 'solana_risk_bot_db',
    password: 'CRIS90app!',
    port: 5432,
});

dbClient.connect().catch(err => console.error("❌ Error connecting to PostgreSQL database on startup:", err));

const bot = new TelegramBot(token, { polling: true });
const botName = "Rug Sniffer";

async function checkNFTPass(walletAddress) {
    return false;
}

function getTrialPeriodInfo(trialStartDate) {
    if (!trialStartDate) return { isActive: false, daysRemaining: 0 };
    const startDate = new Date(trialStartDate);
    const now = new Date();
    const differenceInMilliseconds = now - startDate;
    const differenceInDays = differenceInMilliseconds / (1000 * 60 * 60 * 24);
    const daysRemaining = Math.ceil(5 - differenceInDays);
    return {
        isActive: differenceInDays <= 5,
        daysRemaining: Math.max(0, daysRemaining)
    };
}

async function getTokenNameFromDexScreener(mintAddress) {
    try {
        const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`);
        if (response.data && response.data.pairs && response.data.pairs.length > 0) {
            return response.data.pairs[0].baseToken.name || 'Unknown Token (DexScreener)';
        }
    } catch (error) {
        console.error('❌ Error fetching data from DexScreener API:', error);
    }
    return 'Unknown Token (DexScreener)';
}

async function getWalletTokens(walletAddress) {
    try {
        const publicKeyWallet = new PublicKey(walletAddress);
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
            publicKeyWallet,
            { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }
        );

        const walletTokens = [];

        for (const tokenAccountInfo of tokenAccounts.value) {
            const tokenInfo = tokenAccountInfo.account.data.parsed.info;
            const mintAddress = tokenInfo.mint;
            const balance = tokenInfo.tokenAmount.uiAmount;
            const decimals = tokenInfo.tokenAmount.decimals;

            if (balance <= 0) {
                console.log(`ℹ️ Token with Mint Address ${mintAddress} has zero balance. Ignoring...`);
                continue;
            }

            let tokenName = "Unknown Token";
            let tokenSymbol = "UNKNOWN";

            try {
                const nftMetadata = await metaplex.nfts().findByMint({ mintAddress: new PublicKey(mintAddress) });
                if (nftMetadata && nftMetadata.name && nftMetadata.symbol) {
                    tokenName = nftMetadata.name;
                    tokenSymbol = nftMetadata.symbol;
                } else {
                    console.warn(`⚠️ Metaplex metadata incomplete for Mint Address: ${mintAddress}. Trying Birdeye API fallback.`);
                    try {
                        const birdeyeResponse = await axios.get(`https://public-api.birdeye.so/public/token?address=${mintAddress}`, {
                            headers: { 'X-API-KEY': birdeyeApiKey }
                        });
                        if (birdeyeResponse.data && birdeyeResponse.data.data) {
                            tokenName = birdeyeResponse.data.data.name || 'Unknown Token (Birdeye)';
                            tokenSymbol = birdeyeResponse.data.data.symbol || 'UNKNOWN';
                            console.log(`✅ Token name/symbol found using Birdeye API for Mint Address: ${mintAddress}: Name: ${tokenName}, Symbol: ${tokenSymbol}`);
                        } else {
                            console.warn(`⚠️ Birdeye API did not return token data for Mint Address: ${mintAddress}. Trying DexScreener fallback.`);
                            tokenName = await getTokenNameFromDexScreener(mintAddress);
                        }
                    } catch (birdeyeError) {
                        if (birdeyeError.response && birdeyeError.response.status === 404) {
                            console.warn(`⚠️ Token ${mintAddress} not listed on Birdeye. Trying DexScreener...`);
                        } else {
                            console.error(`❌ Error fetching data from Birdeye for ${mintAddress}:`, birdeyeError.message);
                        }
                        console.warn(`Trying DexScreener API fallback for Mint Address: ${mintAddress}.`);
                        tokenName = await getTokenNameFromDexScreener(mintAddress);
                    }
                }
            } catch (metadataError) {
                console.error(`❌ Error fetching Metaplex metadata for Mint Address: ${mintAddress}:`, metadataError);
                console.warn(`Trying Birdeye API fallback for Mint Address: ${mintAddress}.`);
                try {
                    const birdeyeResponse = await axios.get(`https://public-api.birdeye.so/public/token?address=${mintAddress}`, {
                        headers: { 'X-API-KEY': birdeyeApiKey }
                    });
                    if (birdeyeResponse.data && birdeyeResponse.data.data) {
                        tokenName = birdeyeResponse.data.data.name || 'Unknown Token (Birdeye)';
                        tokenSymbol = birdeyeResponse.data.data.symbol || 'UNKNOWN';
                        console.log(`✅ Token name/symbol found using Birdeye API for Mint Address: ${mintAddress}: Name: ${tokenName}, Symbol: ${tokenSymbol}`);
                    } else {
                        console.warn(`⚠️ Birdeye API did not return token data for Mint Address: ${mintAddress}. Trying DexScreener fallback.`);
                        tokenName = await getTokenNameFromDexScreener(mintAddress);
                    }
                } catch (birdeyeError) {
                    if (birdeyeError.response && birdeyeError.response.status === 404) {
                        console.warn(`⚠️ Token ${mintAddress} not listed on Birdeye. Trying DexScreener...`);
                    } else {
                        console.error(`❌ Error fetching data from Birdeye for ${mintAddress}:`, birdeyeError.message);
                    }
                    console.warn(`Trying DexScreener API fallback for Mint Address: ${mintAddress}.`);
                    tokenName = await getTokenNameFromDexScreener(mintAddress);
                }
            }

            walletTokens.push({
                mintAddress,
                name: tokenName,
                symbol: tokenSymbol,
                balance,
                decimals,
                riskLevel: "Unknown"
            });
        }

        return walletTokens;
    } catch (error) {
        console.error("❌ Error getting wallet tokens:", error);
        return [];
    }
}

const isValidSolanaAddress = (address) => {
    try {
        new PublicKey(address);
        return true;
    } catch (error) {
        return false;
    }
};

function formatWalletAnalysisMessage(token) {
    if (!token || !token.name || !token.symbol || !token.mintAddress || token.riskScore === undefined) {
        return "⚠️ Error: Invalid token data received.";
    }
    const riskEmoji = getRiskColorEmoji(token.riskScore);
    return `${riskEmoji} ${token.name} (${token.symbol})\n` +
           `  Balance: ${token.balance} ${token.symbol}\n` +
           `  [View on Dexscreener](https://dexscreener.com/solana/${token.mintAddress})\n` +
           `  📊 Risk Score: ${token.riskScore}%\n`;
}

async function handleAnalyzeCommand(chatId) {
    try {
        const userResult = await dbClient.query('SELECT wallet_address FROM users WHERE chat_id = $1', [chatId]);
        const user = userResult.rows[0];

        if (!user || !user.wallet_address) {
            return bot.sendMessage(chatId, "⚠️ Please register your Solana wallet address first using the /start command.");
        }

        const walletAddress = user.wallet_address;
        const walletTokens = await getWalletTokens(walletAddress);
        const riskAnalysisResults = await analyzeTokenRisk(walletTokens);

        let finalMessage = "";
        const sentMessageIds = [];

        if (riskAnalysisResults.length === 0) {
            finalMessage = "No tokens found in this wallet with significant balance.";
            const sentMsg = await bot.sendMessage(chatId, finalMessage, { parse_mode: 'Markdown' });
            sentMessageIds.push(sentMsg.message_id);
        } else {
            for (const token of riskAnalysisResults) {
                const messageForToken = formatWalletAnalysisMessage(token);
                const sentMsg = await bot.sendMessage(chatId, messageForToken, { parse_mode: 'Markdown', disable_web_page_preview: true });
                sentMessageIds.push(sentMsg.message_id);
                await new Promise(resolve => setTimeout(resolve, 200));
            }
            finalMessage = "✅ Wallet analysis complete.";
        }

        const analysisButtons = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🔄 Refresh Analysis', callback_data: 'refresh_analysis' }, { text: '⬅️ Back', callback_data: 'back_to_menu' }]
                ]
            },
            parse_mode: 'Markdown'
        };

        if (finalMessage.trim()) {
            const finalSentMsg = await bot.sendMessage(chatId, finalMessage, analysisButtons);
            sentMessageIds.push(finalSentMsg.message_id);
        }

        messageHistory[chatId] = sentMessageIds;
    } catch (error) {
        console.error("❌ Error in handleAnalyzeCommand:", error);
        bot.sendMessage(chatId, "⚠️ Error analyzing wallet. Please try again later.");
    }
}

async function handleAnalyzeTokenCommand(msg) {
    const chatId = msg.chat.id;
    if (!isAwaitingMintAddress[chatId]) {
        await clearWatchlistChat(chatId, messageHistory, bot);
        isAwaitingMintAddress[chatId] = true;
        const sentMsg = await bot.sendMessage(chatId, "Please enter the Mint Address of the token you want to analyze:");
        if (!messageHistory[chatId]) messageHistory[chatId] = [];
        messageHistory[chatId].push(sentMsg.message_id);
    }
}

async function handleStartCommand(msg) {
    const chatId = msg.chat.id;
    try {
        const userResult = await dbClient.query(
            'SELECT wallet_address, trial_start_date, membership_start_date FROM users WHERE chat_id = $1',
            [chatId]
        );
        const user = userResult.rows[0];
        let welcomeMessage = `🚀 Welcome to Rug Sniffer!\n\n🔎 Stay ahead of the game! We analyze token risks using real-time data to help you spot potential rug pulls.\n\n`;
        if (user && user.wallet_address) {
            const membershipInfo = getMembershipInfo(user.membership_start_date, user.trial_start_date);
            if (membershipInfo.isActive) {
                welcomeMessage += membershipInfo.isLifetime 
                    ? `💎 Lifetime Membership Activated!`
                    : membershipInfo.isTrial 
                    ? `🎟 Free Trial: ${membershipInfo.daysRemaining} days remaining`
                    : `🎟 Membership: ${membershipInfo.daysRemaining} days remaining`;
                await clearWatchlistChat(chatId, messageHistory, bot);
                const sentMenu = await bot.sendMessage(chatId, welcomeMessage, createMainMenuKeyboard());
                initialMenuMessageIds[chatId] = sentMenu.message_id;
            } else {
                await clearWatchlistChat(chatId, messageHistory, bot);
                bot.sendMessage(chatId, `❌ Your Free Trial and Membership have expired.\n\n🎟 Upgrade your membership to continue.`, createLimitedMenuKeyboard());
            }
        } else {
            await clearWatchlistChat(chatId, messageHistory, bot);
            bot.sendMessage(chatId, `Welcome! Please enter your Solana wallet address to continue.`, createLimitedMenuKeyboard());
            isAwaitingWalletAddress[chatId] = true;
        }
    } catch (error) {
        console.error("❌ Error processing /start command:", error);
        bot.sendMessage(chatId, "⚠️ Error processing your request. Please try again later.");
    }
}

async function handleAnalyzeWalletCommand(msg) {
    const chatId = msg.chat.id;
    await clearWatchlistChat(chatId, messageHistory, bot);
    await handleAnalyzeCommand(chatId);
}

async function handleAnalyzeTokenManuallyCommand(msg) {
    const chatId = msg.chat.id;
    await clearWatchlistChat(chatId, messageHistory, bot);
    console.log(`🔍 User clicked "Analyze Token". Setting isAwaitingMintAddress[${chatId}] = true`);
    if (isAwaitingMintAddress[chatId]) isAwaitingMintAddress[chatId] = false;
    isAwaitingMintAddress[chatId] = true;
    const sentMsg = await bot.sendMessage(chatId, "Please enter the Mint Address of the token you want to analyze:");
    if (!messageHistory[chatId]) messageHistory[chatId] = [];
    messageHistory[chatId].push(sentMsg.message_id);
}

async function handlePremiumCommand(msg) {
    const chatId = msg.chat.id;
    await clearWatchlistChat(chatId, messageHistory, bot);
    await handleMembershipCommand(messageHistory, bot, msg);
}

async function handleChangeWalletCommand(messageHistory, bot, msg) {
    const chatId = msg.chat.id;
    await clearWatchlistChat(chatId, messageHistory, bot);
    isAwaitingWalletAddress[chatId] = true;
    const sentMsg = await bot.sendMessage(chatId, "⚙️ Enter your new Solana wallet address:", {
        reply_markup: { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "cancel_change_wallet" }]] }
    });
    if (!messageHistory[chatId]) messageHistory[chatId] = [];
    messageHistory[chatId].push(sentMsg.message_id);
}

async function handleCancelChangeWalletCommand(messageHistory, bot, msg) {
    const chatId = msg.chat.id;
    await clearWatchlistChat(chatId, messageHistory, bot);
    isAwaitingWalletAddress[chatId] = false;
    await handleStartCommand(msg);
}

function createMainMenuKeyboard() {
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: "⚙️ Change Wallet", callback_data: 'change_wallet' }, { text: "🎟 Membership", callback_data: 'premium' }],
                [{ text: "🔎 Analyze Wallet", callback_data: 'analyze' }, { text: "🔎 Analyze Token", callback_data: 'analyze_token_manual' }],
                [{ text: "📝 Watchlist", callback_data: 'watchlist_menu' }],
                [{ text: "💎 VIP Group", callback_data: 'vip_group' }, { text: "💡 Help", callback_data: 'help' }]
            ]
        }
    };
}

function createRestrictedMenuKeyboard() {
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: "💡 Help", callback_data: 'help' }, { text: "🎟 Membership", callback_data: 'premium' }]
            ]
        }
    };
}

function createLimitedMenuKeyboard() {
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: "🎟 Membership", callback_data: 'premium' }],
                [{ text: "💡 Help", callback_data: 'help' }]
            ]
        }
    };
}

async function handleHelpCommand(messageHistory, bot, msg) {
    const chatId = msg.chat.id;
    await clearWatchlistChat(chatId, messageHistory, bot);
    const helpMessage = `
📌 *Welcome to Rug Sniffer!*
🔍 *Use this bot to analyze Solana tokens and wallets for potential risks.*

📖 *Main features:*
- **🔎 Analyze Wallet**: Check all tokens in a wallet.
- **🔎 Analyze Token**: Check a specific token by Mint Address.
- **📝 Watchlist**: Track up to 3 tokens.
- **💎 VIP Group**: Exclusive insights for premium members.
- **🎟 Membership**: Upgrade for full access or check your remaining membership days.

⚠ *Always DYOR – This bot provides risk analysis, not financial advice!*
    `;
    const helpButtons = {
        reply_markup: {
            inline_keyboard: [[{ text: "⬅️ Back", callback_data: "back_to_menu" }]]
        },
        parse_mode: "Markdown"
    };
    const sentMsg = await bot.sendMessage(chatId, helpMessage, helpButtons);
    if (!messageHistory[chatId]) messageHistory[chatId] = [];
    messageHistory[chatId].push(sentMsg.message_id);
}

async function handleVIPGroupCommand(msg) {
    const chatId = msg.chat.id;
    await clearWatchlistChat(chatId, messageHistory, bot);
    const vipGroupLink = "https://t.me/seu_grupo_vip_de_exemplo";
    await bot.sendMessage(chatId, `💎 Join our VIP Group for exclusive insights:\n\n[Join VIP Group](${vipGroupLink})`, { parse_mode: 'Markdown' });
}

bot.on('callback_query', async (callbackQuery) => {
    // Verifica se o callbackQuery é válido
    if (!callbackQuery || !callbackQuery.data) {
        console.error("❌ Error: Received an invalid callback_query.", callbackQuery);
        return;
    }

    // Extrai o chatId do callbackQuery.message
    const chatId = callbackQuery.message?.chat?.id;
    if (!chatId) {
        console.error("❌ Error: chatId is undefined in callback_query.", callbackQuery);
        return;
    }

    // Responde imediatamente ao callback para evitar timeout
    bot.answerCallbackQuery(callbackQuery.id, { text: "Processing...", show_alert: false }).catch(err => {
        console.warn(`⚠️ Failed to answer callback for ${chatId}: ${err.message}`);
    });

    const action = callbackQuery.data;

    // Processa as ações com base no callback_data
    switch (action) {
        case 'analyze':
            await handleAnalyzeWalletCommand(callbackQuery.message);
            break;

        case 'analyze_token_manual':
            await handleAnalyzeTokenManuallyCommand(callbackQuery.message);
            break;

        case 'premium':
            await handlePremiumCommand(callbackQuery.message);
            break;

        case 'watchlist_menu':
            await handleWatchlistCommand(messageHistory, bot, callbackQuery.message);
            break;

        case 'vip_group':
            await handleVIPGroupCommand(callbackQuery.message);
            break;

        case 'help':
            await handleHelpCommand(messageHistory, bot, callbackQuery.message);
            break;

        case 'export_csv':
            const csv = await exportWatchlistToCSV(chatId);
            await bot.sendDocument(chatId, Buffer.from(csv, 'utf8'), { filename: 'watchlist.csv' });
            break;

        case 'add_to_watchlist':
            const msgAdd = callbackQuery.message;
            if (!msgAdd || !msgAdd.chat || !msgAdd.chat.id) {
                console.error("❌ Erro: callbackQuery.message está incompleto ou undefined.");
                await bot.sendMessage(chatId, "⚠️ Erro ao processar o comando. Tente novamente.");
                return;
            }
            await handleWatchlistAddCommand({
                messageHistory,
                bot,
                msg: msgAdd,
                mintAddress: null,
                returnToMenuCallback: chatId => handleStartCommand({ chat: { id: chatId } })
            });
            break;

        case 'r_watchlist_token_request':
            await handleRemoveWatchlistTokenRequestCallback(messageHistory, bot, callbackQuery.message);
            break;

        case 'change_wallet':
            await handleChangeWalletCommand(messageHistory, bot, callbackQuery.message);
            break;

        case 'cancel_change_wallet':
            await handleCancelChangeWalletCommand(messageHistory, bot, callbackQuery.message);
            break;

        case 'renew_sol':
            console.log(`🛠️ User clicked on "10$ SOL" - Starting payment flow...`);
            await handleSolPayment(messageHistory, bot, callbackQuery.message);
            break;

        case 'renew_rsf':
            if (RSF_MINT_ADDRESS === "EXEMPLO_DO_MINT_RSFTOKEN") {
                await bot.sendMessage(chatId, "⚠️ Payment with $RSF is not available yet.");
                break;
            }
            await clearWatchlistChat(chatId, messageHistory, bot);
            const paymentId = await generateSolanaPayLink(bot, chatId, 6, null, true);
            const { solAmount } = pendingPayments[paymentId];
            const payLinkRSF = `https://neural-trades.github.io/rugsniffer/index.html?recipient=DSHKTg2ZBZKWTYQiLY72gtjkjXxeknuzCZdJY3U8pP5i&amount=${solAmount}&spl-token=${RSF_MINT_ADDRESS}`;
            await bot.sendMessage(chatId, `💰 *Renew Membership with $RSF*\n(Pay $6 in $RSF Tokens)\n\nPlease click ✅ after completing the transaction.`, {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "🔗 Pay with Solana Pay", url: payLinkRSF }],
                        [{ text: "✅ I have paid", callback_data: `confirm_payment_${paymentId}` }],
                        [{ text: "❌ Cancel", callback_data: `cancel_payment_${paymentId}` }]
                    ]
                }
            });
            break;

        case 'back_to_menu':
            await clearWatchlistChat(chatId, messageHistory, bot);
            await handleStartCommand(callbackQuery.message);
            break;

        case 'refresh_analysis':
            await clearWatchlistChat(chatId, messageHistory, bot);
            await handleAnalyzeCommand(chatId);
            break;

        case 'enter_txid':
            isAwaitingTxId[chatId] = true;
            await bot.sendMessage(chatId, "Please enter your Transaction ID (TXID):");
            break;

        case 'cancel_txid':
            isAwaitingTxId[chatId] = false;
            await bot.sendMessage(chatId, "Transaction ID entry cancelled.");
            break;

        default:
            if (action.startsWith('remove_')) {
                await handleRemoveTokenCallback(messageHistory, bot, callbackQuery);
            } else if (action.startsWith('add_watchlist_')) {
                const mintAddress = action.replace("add_watchlist_", "");
                console.log(`🛠️ Adding Mint Address ${mintAddress} to watchlist for user ${chatId}`);
                
                const msgWatch = callbackQuery.message;
                if (!msgWatch || !msgWatch.chat || !msgWatch.chat.id) {
                    console.error("❌ Erro: callbackQuery.message está indefinido ou incompleto.");
                    await bot.sendMessage(chatId, "⚠️ Erro ao adicionar token à Watchlist. Tente novamente mais tarde.");
                    return;
                }
                
                try {
                    await handleWatchlistAddCommand({
                        messageHistory,
                        bot,
                        msg: msgWatch,
                        mintAddress: mintAddress,
                        returnToMenuCallback: chatId => handleStartCommand({ chat: { id: chatId } })
                    });
                } catch (error) {
                    console.error(`❌ Error adding token to watchlist for ${chatId}:`, error);
                    await bot.sendMessage(chatId, "⚠️ Erro ao adicionar token à Watchlist. Tente novamente.");
                }
            } else if (action.startsWith('proceed_without_referral_')) {
                const paymentId = action.replace("proceed_without_referral_", "");
                if (!pendingPayments[paymentId]) {
                    console.log(`❌ Payment session expired for user ${chatId}`);
                    await bot.sendMessage(chatId, "⚠️ Payment session expired. Please try again.");
                    break;
                }
                pendingPayments[paymentId].referralId = null;
                await clearWatchlistChat(chatId, messageHistory, bot);
                const { solAmount, memoValue } = pendingPayments[paymentId];
                const payLink = `https://neural-trades.github.io/rugsniffer/index.html?recipient=DSHKTg2ZBZKWTYQiLY72gtjkjXxeknuzCZdJY3U8pP5i&amount=${solAmount}&memo=${memoValue}`;
                await bot.sendMessage(chatId, `💰 *Payment of $10 in SOL*\n(${solAmount} SOL)\n\nPlease click ✅ after completing the transaction.`, {
                    parse_mode: "Markdown",
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "🔗 Pay with Solana Pay", url: payLink }],
                            [{ text: "✅ I have paid", callback_data: `confirm_payment_${paymentId}` }],
                            [{ text: "❌ Cancel", callback_data: `cancel_payment_${paymentId}` }]
                        ]
                    }
                });
            } else if (action.startsWith('pay_')) {
                const paymentId = action.replace("pay_", "");
                if (!pendingPayments[paymentId]) {
                    console.log(`❌ Payment session expired for user ${chatId}`);
                    await bot.sendMessage(chatId, "⚠️ Payment session expired. Please try again.");
                    break;
                }
                await clearWatchlistChat(chatId, messageHistory, bot);
                const { solAmount } = pendingPayments[paymentId];
                const payLink = `https://neural-trades.github.io/rugsniffer/index.html?recipient=DSHKTg2ZBZKWTYQiLY72gtjkjXxeknuzCZdJY3U8pP5i&amount=${solAmount}`;
                await bot.sendMessage(chatId, `💰 *Payment of $10 in SOL (${solAmount} SOL)*`, {
                    parse_mode: "Markdown",
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "🔗 Pay with Solana Pay", url: payLink }],
                            [{ text: "✅ I have paid", callback_data: `confirm_payment_${paymentId}` }],
                            [{ text: "❌ Cancel", callback_data: `cancel_payment_${paymentId}` }]
                        ]
                    }
                });
            } else if (action.startsWith('confirm_payment_')) {
                const paymentId = action.replace("confirm_payment_", "");
                await handlePaymentConfirmation(bot, chatId);
                delete pendingPayments[paymentId];
                isAwaitingReferral[chatId] = false;
            } else if (action.startsWith('cancel_payment_')) {
                const paymentId = action.replace("cancel_payment_", "");
                delete pendingPayments[paymentId];
                isAwaitingReferral[chatId] = false;
                await clearWatchlistChat(chatId, messageHistory, bot);
                await handleStartCommand(callbackQuery.message);
            }
            break;
    }
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    console.log(`📩 Received message: "${text}" from user ${chatId}`);

    if (text === '/start') {
        await handleStartCommand(msg);
    } else if (text === '/analyze_wallet') {
        await handleAnalyzeWalletCommand(msg);
    } else if (text === '/analyze_token') {
        await handleAnalyzeTokenCommand(msg);
    } else if (text === '/membership') {
        await handleMembershipCommand(messageHistory, bot, msg);
    } else if (text === '/watchlist') {
        await handleWatchlistCommand(messageHistory, bot, msg);
    } else if (text === '/help') {
        await handleHelpCommand(messageHistory, bot, msg);
    } else if (isAwaitingMintAddress[chatId]) {
        isAwaitingMintAddress[chatId] = false;
        const mintAddress = text.trim();
        if (!isValidMintAddress(mintAddress)) {
            await bot.sendMessage(chatId, "❌ Invalid Mint Address. Please enter a valid Solana Mint Address.");
        } else {
            const tokenAnalysis = (await analyzeTokenRisk([{ mintAddress }]))[0];
            const formattedMessage = formatTokenRiskAnalysis(tokenAnalysis);
            await bot.sendMessage(chatId, formattedMessage, { parse_mode: 'Markdown', disable_web_page_preview: true });
            const watchlistButtons = {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '⭐ Add to Watchlist', callback_data: `add_watchlist_${mintAddress}` }],
                        [{ text: '⬅️ Back', callback_data: 'back_to_menu' }]
                    ]
                }
            };
            await bot.sendMessage(chatId, "Manage this token:", watchlistButtons);
        }
        if (messageHistory[chatId]) messageHistory[chatId] = messageHistory[chatId].filter(id => id !== msg.message_id);
    } else if (isAwaitingReferral[chatId]) {
        if (await processReferralInput(messageHistory, bot, msg, text)) return;
    } else if (isAwaitingTxId[chatId]) {
        const txId = text.trim();
        isAwaitingTxId[chatId] = false;
        const isValidTx = await checkSolTransaction(txId, chatId);
        if (isValidTx) {
            await bot.sendMessage(chatId, "✅ Transaction confirmed! Membership activated.");
            await updateUserMembership(chatId, null, bot);
        } else {
            await bot.sendMessage(chatId, "❌ Invalid or unconfirmed Transaction ID. Please try again or contact support.");
            isAwaitingTxId[chatId] = true;
        }
    } else if (isAwaitingWalletAddress[chatId]) {
        const walletAddress = text.trim();
        if (!isValidSolanaAddress(walletAddress)) {
            await bot.sendMessage(chatId, "❌ Invalid Solana wallet address. Please try again.");
        } else {
            try {
                await dbClient.query(
                    'INSERT INTO users (chat_id, wallet_address, trial_start_date) VALUES ($1, $2, CURRENT_DATE) ' +
                    'ON CONFLICT (chat_id) DO UPDATE SET wallet_address = $2, trial_start_date = EXCLUDED.trial_start_date',
                    [chatId, walletAddress]
                );
                await bot.sendMessage(chatId, `✅ Wallet updated to: ${walletAddress}.`);
                isAwaitingWalletAddress[chatId] = false;
                await handleStartCommand(msg);
            } catch (error) {
                console.error("❌ Database error updating wallet address:", error);
                await bot.sendMessage(chatId, "⚠️ Error saving wallet address. Please try again later.");
            }
        }
    } else if (isAwaitingMintAddressForWatchlist[chatId]) {
        await handleUserInput(messageHistory, bot, msg, text, chatId => handleStartCommand({ chat: { id: chatId } }));
    } else {
        await bot.sendMessage(chatId, "⚠️ Unknown command. Use /start or the menu for options.");
    }
});

bot.on('polling_error', (error) => {
    console.error("Telegram Polling Error:", error);
});

console.log(`${botName} Bot is running...`);
