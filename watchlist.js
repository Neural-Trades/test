const { Pool } = require('pg');
const { getRiskColorEmoji, formatTokenRiskAnalysis, analyzeTokenRisk } = require('./risk');
const { PublicKey } = require("@solana/web3.js");

const pool = new Pool({
    user: 'bot_user',
    host: 'localhost',
    database: 'solana_risk_bot_db',
    password: 'CRIS90app!',
    port: 5432,
    query_timeout: 5000
});

const isAwaitingMintAddressForWatchlist = {};
const riskCache = new Map();
const RISK_CACHE_TTL = 5 * 60 * 1000;

async function clearChat(chatId, messageHistory, bot) {
    if (!messageHistory || !messageHistory[chatId]) {
        messageHistory = messageHistory || {};
        messageHistory[chatId] = [];
    }
    const messagesToDelete = [...messageHistory[chatId]];
    for (const messageId of messagesToDelete) {
        try {
            await bot.deleteMessage(chatId, messageId);
        } catch (error) {
            console.error(`⚠️ Error deleting message ${messageId} in chat ${chatId}:`, error);
        }
    }
    messageHistory[chatId] = [];
}

async function getCachedRiskAnalysis(mintAddress) {
    const cached = riskCache.get(mintAddress);
    if (cached && (Date.now() - cached.timestamp < RISK_CACHE_TTL)) return cached.data;
    const data = await analyzeTokenRisk([{ mintAddress }]);
    riskCache.set(mintAddress, { data: data[0], timestamp: Date.now() });
    return data[0];
}

async function handleWatchlistCommand(messageHistory, bot, msg) {
    const chatId = msg.chat.id;
    await clearChat(chatId, messageHistory, bot);
    try {
        const watchlist = await getUserWatchlist(chatId);
        if (watchlist.length === 0) {
            const sentMessage = await bot.sendMessage(chatId, "📝 Your Watchlist is empty.", {
                reply_markup: { inline_keyboard: [[{ text: "➕ Add", callback_data: 'add_to_watchlist' }], [{ text: "⬅️ Back to Menu", callback_data: 'back_to_menu' }]] }
            });
            messageHistory[chatId].push(sentMessage.message_id);
            return;
        }
        const riskPromises = watchlist.map(mintAddress => getCachedRiskAnalysis(mintAddress));
        const riskAnalyses = await Promise.all(riskPromises);
        const averageRisk = riskAnalyses.reduce((sum, t) => sum + (t?.riskScore || 0), 0) / watchlist.length || 0;
        const summary = `📊 *Watchlist Summary: Average Risk ${averageRisk.toFixed(1)}%*\n`;
        const sentSummary = await bot.sendMessage(chatId, summary, { parse_mode: 'Markdown' });
        messageHistory[chatId].push(sentSummary.message_id);
        for (const tokenRiskAnalysis of riskAnalyses) {
            if (tokenRiskAnalysis) {
                const formattedMessage = formatTokenRiskAnalysis(tokenRiskAnalysis);
                const sentMessage = await bot.sendMessage(chatId, formattedMessage, { parse_mode: 'Markdown', disable_web_page_preview: false });
                messageHistory[chatId].push(sentMessage.message_id);
            }
        }
        const delay = Math.min(200 * watchlist.length, 1000);
        await new Promise(resolve => setTimeout(resolve, delay));
        const sentMessage = await bot.sendMessage(chatId, "📋 Manage your Watchlist:", {
            reply_markup: { inline_keyboard: [[{ text: "➕ Add to Watchlist", callback_data: 'add_to_watchlist' }], [{ text: "➖ Remove Token", callback_data: 'r_watchlist_token_request' }], [{ text: "⬅️ Back to Menu", callback_data: 'back_to_menu' }]] }
        });
        messageHistory[chatId].push(sentMessage.message_id);
    } catch (error) {
        console.error("❌ Error handling /watchlist command:", error);
        bot.sendMessage(chatId, "⚠️ Error displaying Watchlist. Please try again later.");
    }
}

async function handleWatchlistAddCommand({ messageHistory, bot, msg, mintAddress = null, returnToMenuCallback }) {
    const chatId = msg.chat.id;
    try {
        const watchlistTokenCount = await getUserWatchlistTokenCount(chatId);
        if (watchlistTokenCount >= 3) {
            await bot.sendMessage(chatId, "⚠️ Atingiu o limite máximo de 3 tokens na sua Watchlist.\nRemova um token para adicionar outro.");
            return;
        }

        if (mintAddress) {
            const processingMsg = await bot.sendMessage(chatId, "A adicionar token à Watchlist. Por favor, aguarde...");
            messageHistory[chatId].push(processingMsg.message_id);

            const added = await addUserWatchlistToken(chatId, mintAddress);

            await bot.deleteMessage(chatId, processingMsg.message_id);

            if (added) {
                const successMsg = await bot.sendMessage(chatId, `✅ Token \`${mintAddress}\` adicionado à sua Watchlist!`, { parse_mode: 'Markdown' });
                messageHistory[chatId].push(successMsg.message_id);
            } else {
                const errorMsg = await bot.sendMessage(chatId, `⚠️ Não foi possível adicionar o token \`${mintAddress}\`. Talvez já esteja na sua Watchlist.`, { parse_mode: 'Markdown' });
                messageHistory[chatId].push(errorMsg.message_id);
            }

            await new Promise(resolve => setTimeout(resolve, 200));
            await clearChat(chatId, messageHistory, bot);
            await handleWatchlistCommand({ messageHistory, bot, msg });
            return;
        }

        isAwaitingMintAddressForWatchlist[chatId] = true;
        const sentMessage = await bot.sendMessage(chatId, "➕ Introduza o Mint Address do token que deseja adicionar à sua Watchlist:");
        if (!messageHistory[chatId]) messageHistory[chatId] = [];
        messageHistory[chatId].push(sentMessage.message_id);
    } catch (error) {
        console.error("❌ Erro ao lidar com 'add_to_watchlist':", error);
        //await bot.sendMessage(chatId, "⚠️ Erro ao adicionar à Watchlist. Tente novamente mais tarde.");
    }
}

async function handleRemoveWatchlistTokenRequestCallback(messageHistory, bot, msg) {
    const chatId = msg.chat.id;
    console.log(`✅ Received /remove_watchlist_token_request in chat ${chatId}`);
    await clearChat(chatId, messageHistory, bot);
    try {
        const watchlist = await getUserWatchlist(chatId);
        console.log(`📋 Watchlist fetched:`, watchlist);
        if (watchlist.length === 0) {
            const sentMessage = await bot.sendMessage(chatId, "📭 Your Watchlist is empty.");
            messageHistory[chatId].push(sentMessage.message_id);
            return;
        }
        const inlineKeyboardButtons = watchlist.map(mintAddress => [{ text: `🗑 Remove ${mintAddress}`, callback_data: `remove_${mintAddress}` }]);
        inlineKeyboardButtons.push([{ text: "⬅️ Back to Menu", callback_data: 'back_to_menu' }]);
        console.log(`🔹 Sending remove token menu with buttons:`, inlineKeyboardButtons);
        const sentMessage = await bot.sendMessage(chatId, "🗒 Select a token to remove:", {
            reply_markup: { inline_keyboard: inlineKeyboardButtons }
        });
        messageHistory[chatId].push(sentMessage.message_id);
    } catch (error) {
        console.error("❌ Error displaying watchlist for removal:", error);
        bot.sendMessage(chatId, "⚠️ Error fetching Watchlist. Please try again.");
    }
}

async function handleRemoveTokenCallback(messageHistory, bot, query) {
    if (!query || !query.message || !query.message.chat) {
        console.error("❌ Error: query.message or query.message.chat is undefined.", query);
        return;
    }
    const chatId = query.message.chat.id;
    const mintAddress = query.data.replace("remove_", "");
    try {
        const removed = await removeUserWatchlistTokenFromDB(chatId, mintAddress);
        if (removed) {
            await bot.answerCallbackQuery(query.id, { text: `✅ Token removed!`, show_alert: true });
            await handleWatchlistCommand(messageHistory, bot, { chat: { id: chatId } });
        } else {
            await bot.answerCallbackQuery(query.id, { text: `⚠️ Error removing token.`, show_alert: true });
        }
    } catch (error) {
        console.error("❌ Error removing token:", error);
        await bot.answerCallbackQuery(query.id, { text: "⚠️ Error. Try again.", show_alert: true });
    }
}

async function handleUserInput(messageHistory, bot, msg, text, returnToMenuCallback) {
    const chatId = msg.chat.id;

    if (!text || typeof text !== "string") {
        console.error(`⚠️ Error: Invalid input received in chat ${chatId}.`);
        return false;
    }

    const mintAddress = text.trim();

    if (isAwaitingMintAddressForWatchlist[chatId]) {
        isAwaitingMintAddressForWatchlist[chatId] = false;

        if (!messageHistory[chatId]) {
            messageHistory[chatId] = [];
        }

        messageHistory[chatId].push(msg.message_id);

        if (messageHistory[chatId].length > 0) {
            try {
                await bot.deleteMessage(chatId, messageHistory[chatId].shift());
            } catch (error) {
                console.error(`⚠️ Error deleting "Enter Mint Address" message in chat ${chatId}:`, error);
            }
        }

        if (!isValidMintAddress(mintAddress)) {
            const errorMsg = await bot.sendMessage(chatId, `⚠️ Invalid Mint Address. Please enter a valid Mint Address (Solana).`);
            messageHistory[chatId].push(errorMsg.message_id);
            setTimeout(async () => {
                try {
                    await bot.deleteMessage(chatId, msg.message_id);
                    await bot.deleteMessage(chatId, errorMsg.message_id);
                } catch (error) {
                    console.error(`⚠️ Error deleting invalid Mint Address messages in chat ${chatId}:`, error);
                }
                await handleWatchlistCommand(messageHistory, bot, msg);
            }, 200);
            return true;
        }

        await bot.answerCallbackQuery(msg.id, { text: "Processing...", show_alert: false }).catch(err => {
            console.warn(`⚠️ Failed to answer callback for ${chatId}: ${err.message}`);
        });
        console.time('addTokenProcess');
        (async () => {
            try {
                const added = await addUserWatchlistToken(chatId, mintAddress);
                const messages = [];
                if (added) {
                    const successMsg = await bot.sendMessage(chatId, `✅ Token \`${mintAddress}\` added to your Watchlist!`, { parse_mode: 'Markdown' });
                    messages.push(successMsg.message_id);
                } else {
                    const errorMsg = await bot.sendMessage(chatId, `⚠️ Could not add token \`${mintAddress}\`. Maybe it's already in your Watchlist.`, { parse_mode: 'Markdown' });
                    messages.push(errorMsg.message_id);
                }
                await new Promise(resolve => setTimeout(resolve, 200));
                messageHistory[chatId] = messageHistory[chatId].concat(messages);
                await clearChat(chatId, messageHistory, bot);
                if (returnToMenuCallback && typeof returnToMenuCallback === 'function') {
                    await returnToMenuCallback({ chat: { id: chatId } });
                } else if (typeof returnToMenuCallback === 'string' || typeof returnToMenuCallback === 'number') {
                    await handleStartCommand({ chat: { id: returnToMenuCallback } });
                }
            } catch (error) {
                console.error(`❌ Error adding token to watchlist for ${chatId}:`, error);
                const errorMsg = await bot.sendMessage(chatId, "⚠️ Error adding token to watchlist. Please try again.");
                messageHistory[chatId].push(errorMsg.message_id);
                await new Promise(resolve => setTimeout(resolve, 200));
                await clearChat(chatId, messageHistory, bot);
                if (returnToMenuCallback && typeof returnToMenuCallback === 'function') {
                    await returnToMenuCallback({ chat: { id: chatId } });
                } else if (typeof returnToMenuCallback === 'string' || typeof returnToMenuCallback === 'number') {
                    await handleStartCommand({ chat: { id: returnToMenuCallback } });
                }
            } finally {
                console.timeEnd('addTokenProcess');
            }
        })();
        return true;
    }
    return false;
}

function isValidMintAddress(mintAddress) {
    try {
        new PublicKey(mintAddress);
        return true;
    } catch (error) {
        return false;
    }
}

async function getUserWatchlist(chatId) {
    try {
        const res = await pool.query('SELECT mint_address FROM watchlists WHERE chat_id = $1', [chatId]);
        return res.rows.map(row => row.mint_address);
    } catch (error) {
        console.error("❌ Error fetching watchlist from database:", error);
        return [];
    }
}

async function addUserWatchlistToken(chatId, mintAddress) {
    try {
        const checkResult = await pool.query('SELECT mint_address FROM watchlists WHERE chat_id = $1 AND mint_address = $2', [chatId, mintAddress]);
        if (checkResult.rows.length > 0) return false;

        await pool.query('INSERT INTO watchlists (chat_id, mint_address) VALUES ($1, $2)', [chatId, mintAddress]);
        return true;
    } catch (error) {
        console.error("❌ Error adding token to watchlist:", error);
        return false;
    }
}

async function removeUserWatchlistTokenFromDB(chatId, mintAddress) {
    try {
        const deleteResult = await pool.query('DELETE FROM watchlists WHERE chat_id = $1 AND mint_address = $2', [chatId, mintAddress]);
        return deleteResult.rowCount > 0;
    } catch (error) {
        console.error("❌ Error removing token from watchlist:", error);
        return false;
    }
}

async function getUserWatchlistTokenCount(chatId) {
    try {
        const res = await pool.query('SELECT COUNT(*) FROM watchlists WHERE chat_id = $1', [chatId]);
        return parseInt(res.rows[0].count, 10);
    } catch (error) {
        console.error("❌ Error fetching watchlist token count from database:", error);
        return 0;
    }
}

async function exportWatchlistToCSV(chatId) {
    const watchlist = await getUserWatchlist(chatId);
    const riskPromises = watchlist.map(mintAddress => getCachedRiskAnalysis(mintAddress));
    const riskAnalyses = await Promise.all(riskPromises);
    const csv = [
        'Mint Address,Risk Score,Risk Level',
        ...riskAnalyses.map(t => `${t.mintAddress},${t.riskScore},${t.riskLevel}`).join('\n')
    ].join('\n');
    return Buffer.from(csv).toString('base64');
}

module.exports = {
    handleWatchlistCommand,
    handleWatchlistAddCommand,
    handleRemoveWatchlistTokenRequestCallback,
    handleRemoveTokenCallback,
    getUserWatchlist,
    addUserWatchlistToken,
    removeUserWatchlistToken: removeUserWatchlistTokenFromDB,
    getUserWatchlistTokenCount,
    handleUserInput,
    isAwaitingMintAddressForWatchlist,
    clearChat,
    isValidMintAddress
};
