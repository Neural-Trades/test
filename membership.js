const { getMembershipInfo } = require("./utils");
const { clearChat } = require("./watchlist");
const { Client } = require("pg");
const axios = require("axios");
const { pendingPayments } = require("./utils");
const { PublicKey, Connection, Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL } = require("@solana/web3.js");

// Conexão com o banco de dados
const dbClient = new Client({
    user: "bot_user",
    host: "localhost",
    database: "solana_risk_bot_db",
    password: "CRIS90app!",
    port: 5432,
});
dbClient.connect().catch((err) => console.error("❌ Error connecting to PostgreSQL:", err));

const RSF_MINT_ADDRESS = "EXEMPLO_DO_MINT_RSFTOKEN"; // Placeholder até criar o token
const WALLET_PRIVATE_KEY = null; // Substitua por uma chave segura ou use um serviço externo (ex.: QuickNode)

const isAwaitingReferral = {};
const isAwaitingConfirmation = {};
const solPriceCache = new Map();

async function handleMembershipCommand(messageHistory, bot, msg) {
    const chatId = msg.chat.id;
    await clearChat(chatId, messageHistory, bot);
    try {
        const userResult = await dbClient.query("SELECT membership_start_date, trial_start_date FROM users WHERE chat_id = $1", [chatId]);
        const user = userResult.rows[0];
        const membershipInfo = getMembershipInfo(user?.membership_start_date, user?.trial_start_date);
        let membershipMessage = `🎟 *Your Membership Status:*\n\n`;
        let buttons = [];
        if (membershipInfo.isLifetime) {
            membershipMessage += `💎 *Lifetime Membership* 💎\n\n`;
            membershipMessage += `💰 *Referral Bonus:* Earn *$1 in SOL* for every new member who subscribes using your referral code!\n\n`;
            membershipMessage += `🔗 *Your Referral Code:* \`${chatId}\``;
            buttons = [[{ text: "✅ OK", callback_data: "back_to_menu" }]];
        } else {
            membershipMessage += membershipInfo.isActive
                ? `✅ *Active Membership*\n🗓 *Days Remaining:* ${Math.round(membershipInfo.daysRemaining)}\n\n`
                : `⚠️ *Your membership has expired!*\n\n`;
            membershipMessage += `💰 *Referral Bonus:* Earn *10 extra days* when someone subscribes using your referral code!\n\n`;
            membershipMessage += `🔗 *Your Referral Code:* \`${chatId}\`\n\n`;
            membershipMessage += `*Get a discount when paying with a referral or with $RSF.*`;
            buttons = [
                [{ text: "💰 10$ in SOL", callback_data: "renew_sol" }, { text: "💰 6$ in RSF", callback_data: "renew_rsf" }],
                [{ text: "⬅️ Back", callback_data: "back_to_menu" }]
            ];
        }
        const sentMsg = await bot.sendMessage(chatId, membershipMessage, {
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: buttons }
        });
        messageHistory[chatId] = [sentMsg.message_id];
    } catch (error) {
        console.error("❌ Error handling membership command:", error);
        bot.sendMessage(chatId, "⚠️ Error fetching membership details. Please try again later.");
    }
}

async function generateSolanaPayLink(bot, chatId, amountUSD, referralId, isRSF = false) {
    try {
        console.log(`🔗 Generating Solana Pay link... Referral: ${referralId || "None"}`);
        const solPrice = await getSolanaPrice();
        if (!solPrice) throw new Error("Failed to fetch SOL price.");
        if (isRSF && RSF_MINT_ADDRESS === "EXEMPLO_DO_MINT_RSFTOKEN") return bot.sendMessage(chatId, "⚠️ Payment with $RSF is not available yet.");
        let finalAmountUSD = referralId ? amountUSD * 0.65 : amountUSD;
        let solAmount = (finalAmountUSD / solPrice).toFixed(6);
        const recipientWallet = "DSHKTg2ZBZKWTYQiLY72gtjkjXxeknuzCZdJY3U8pP5i";
        let solanaPayRedirectUrl = `https://neural-trades.github.io/rugsniffer/index.html?recipient=${recipientWallet}&amount=${solAmount}&chat_id=${chatId}`;
        if (isRSF && RSF_MINT_ADDRESS !== "EXEMPLO_DO_MINT_RSFTOKEN") solanaPayRedirectUrl += `&spl-token=${RSF_MINT_ADDRESS}`;
        let memoValue = `${chatId}`;
        if (referralId && !isRSF) memoValue += `_Referral_${referralId}`;
        else if (isRSF && referralId) return bot.sendMessage(chatId, "⚠️ Referrals cannot be used with $RSF payments.");
        solanaPayRedirectUrl += `&memo=${memoValue}`;
        const paymentId = `${chatId}-${Date.now()}`;
        pendingPayments[paymentId] = { chatId, solAmount, recipientWallet, referralId, memoValue };
        console.log(`✅ Payment session created: ${paymentId}`);
        return paymentId;
    } catch (error) {
        console.error("❌ Error generating Solana Pay link:", error);
        bot.sendMessage(chatId, "⚠️ Error generating payment link. Please try again later.");
    }
}

async function listenForSolanaPayment(chatId, bot, amount, recipientWallet, referralId) {
    const solanaRpcUrl = "https://api.mainnet-beta.solana.com";
    const endTime = Math.floor(Date.now() / 1000) + 300;
    await bot.sendMessage(chatId, "⏳ *Confirming the transaction, please wait...* \n\n This may take a few minutes.", { parse_mode: "Markdown" });
    console.log(`👀 Listening for payment with Memo... Checking every 15 seconds for up to 5 minutes.`);
    while (Math.floor(Date.now() / 1000) < endTime) {
        console.log(`🔄 Checking for incoming transactions to ${recipientWallet}...`);
        try {
            const response = await axios.post(solanaRpcUrl, {
                jsonrpc: "2.0",
                id: 1,
                method: "getSignaturesForAddress",
                params: [recipientWallet, { limit: 20 }]
            }, { timeout: 10000 });
            if (!response.data?.result?.length) {
                console.log("⚠️ Nenhuma transação encontrada!");
                continue;
            }
            for (const tx of response.data.result) {
                const txId = tx.signature;
                const memoData = tx.memo ? tx.memo.trim() : "";
                console.log(`🔍 Transação encontrada: ${txId} | Memo: "${memoData}"`);
                if (memoData.includes(chatId)) {
                    console.log(`✅ Payment found with Memo! Transaction ID: ${txId}`);
                    await bot.sendMessage(chatId, "✅ *Payment confirmed! Your membership has been activated.*", { parse_mode: "Markdown" });
                    await updateUserMembership(chatId, referralId, bot);
                    await dbClient.query("INSERT INTO referrals (referrer_id, referred_id, status) VALUES ($1, $2, 'success')", [referralId, chatId]);
                    return;
                }
            }
        } catch (error) {
            console.error("⚠️ Error while checking for payment:", error);
        }
        await new Promise(resolve => setTimeout(resolve, 15000));
    }
    console.log("❌ Payment not found after 5 minutes.");
    await bot.sendMessage(chatId, "❌ *Transaction not found.*\n\nIf you completed the transfer, please enter your *Transaction ID (TXID)* below or contact support.", { parse_mode: "Markdown" });
}

async function getSolanaPrice() {
    const cached = solPriceCache.get('solPrice');
    if (cached && (Date.now() - cached.timestamp < 5 * 60 * 1000)) return cached.price;
    try {
        console.log("🔄 Fetching Solana price from API...");
        const response = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", { timeout: 5000 });
        const price = response.data.solana.usd;
        solPriceCache.set('solPrice', { price, timestamp: Date.now() });
        return price;
    } catch (error) {
        console.error("❌ Error fetching Solana price:", error.message || error);
        return null;
    }
}

async function handleSolPayment(messageHistory, bot, msg) {
    const chatId = msg.chat.id;
    if (Object.values(pendingPayments).some(p => p.chatId === chatId)) {
        console.log(`⚠️ Existing payment session found for user: ${chatId}`);
        await bot.sendMessage(chatId, "⚠️ You already have a pending payment. Please complete it before starting a new one.");
        return;
    }
    try {
        console.log(`🛠️ Starting SOL Payment process for user: ${chatId}`);
        await clearChat(chatId, messageHistory, bot);
        messageHistory[chatId] = [];
        const solPrice = await getSolanaPrice();
        if (!solPrice) {
            await bot.sendMessage(chatId, "⚠️ Error fetching SOL price. Please try again later.");
            return;
        }
        let paymentId = await generateSolanaPayLink(bot, chatId, 10, null, false);
        console.log(`✅ Payment session initiated with ID: ${paymentId}`);
        const buttons = [[{ text: "Proceed without referral", callback_data: `proceed_without_referral_${paymentId}` }]];
        if (!messageHistory[chatId]) messageHistory[chatId] = [];
        if (!messageHistory[chatId].some(msg => msg.includes("Insert a referral below"))) {
            const sentMsg = await bot.sendMessage(chatId, `Insert a referral below or continue without referral.`, {
                parse_mode: "Markdown",
                reply_markup: { inline_keyboard: buttons }
            });
            messageHistory[chatId].push(sentMsg.message_id);
        }
        isAwaitingReferral[chatId] = true;
    } catch (error) {
        console.error("❌ Error handling SOL payment:", error);
        bot.sendMessage(chatId, "⚠️ Error processing payment request. Please try again later.");
    }
}

async function processReferralInput(messageHistory, bot, msg, text) {
    const chatId = msg.chat.id;
    await clearChat(chatId, messageHistory, bot);
    try {
        await bot.deleteMessage(chatId, msg.message_id);
    } catch (error) {
        console.error(`⚠️ Error deleting user input in chat ${chatId}:`, error);
    }
    if (!isAwaitingReferral[chatId]) return false;
    if (!/^\d+$/.test(text)) {
        console.log(`❌ Invalid referral code format received: ${text}`);
        const errorMsg = await bot.sendMessage(chatId, "❌ Invalid referral code format! Please enter only numbers or proceed without referral.", { parse_mode: "Markdown" });
        messageHistory[chatId].push(errorMsg.message_id);
        return true;
    }
    if (text === String(chatId)) {
        console.log(`⚠️ User ${chatId} tried to use their own referral code.`);
        const selfReferralMsg = await bot.sendMessage(chatId, "❌ You cannot use your own referral code!", { parse_mode: "Markdown" });
        messageHistory[chatId].push(selfReferralMsg.message_id);
        return true;
    }
    try {
        const referralQueryResult = await dbClient.query("SELECT membership_start_date FROM users WHERE chat_id = $1", [text]);
        if (!referralQueryResult.rows.length) {
            console.log(`❌ Referral code ${text} does not exist.`);
            const invalidReferralMsg = await bot.sendMessage(chatId, "❌ Invalid referral code. Please enter a valid referral or proceed without referral.", { parse_mode: "Markdown" });
            messageHistory[chatId].push(invalidReferralMsg.message_id);
            return true;
        }
        console.log(`✅ Referral accepted! Applying discount for user ${chatId}.`);
        const solPrice = await getSolanaPrice();
        if (!solPrice) {
            console.error("❌ Error fetching SOL price.");
            const solPriceErrorMsg = await bot.sendMessage(chatId, "⚠️ Error fetching SOL price. Please try again later.");
            messageHistory[chatId].push(solPriceErrorMsg.message_id);
            return true;
        }
        let discountedAmountUSD = 10 * 0.65;
        let solAmount = (discountedAmountUSD / solPrice).toFixed(6);
        let paymentId = Object.keys(pendingPayments).find(p => pendingPayments[p].chatId === chatId);
        if (!paymentId) {
            console.error(`❌ Payment session not found for user ${chatId} after entering referral.`);
            const noPaymentMsg = await bot.sendMessage(chatId, "⚠️ Error: No active payment session found. Please start the payment process again.");
            messageHistory[chatId].push(noPaymentMsg.message_id);
            return false;
        }
        pendingPayments[paymentId].solAmount = solAmount;
        pendingPayments[paymentId].referralId = text;
        const confirmationMsg = await bot.sendMessage(chatId, `✅ *Referral accepted!* Your new payment amount is *$${discountedAmountUSD.toFixed(2)}* (${solAmount} SOL).`, {
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [[{ text: "🔗 Pay with Solana Pay", callback_data: `pay_${paymentId}` }], [{ text: "❌ Cancel", callback_data: `cancel_payment_${paymentId}` }]] }
        });
        messageHistory[chatId].push(confirmationMsg.message_id);
        isAwaitingReferral[chatId] = false;
        return true;
    } catch (error) {
        console.error("❌ Error processing referral:", error);
        const referralErrorMsg = await bot.sendMessage(chatId, "⚠️ Error processing referral. Please try again later.");
        messageHistory[chatId].push(referralErrorMsg.message_id);
        return false;
    }
}

async function updateUserMembership(chatId, referralId, bot) {
    try {
        const userResult = await dbClient.query("SELECT membership_start_date FROM users WHERE chat_id = $1", [chatId]);
        const user = userResult.rows[0];
        let newMembershipDate = user?.membership_start_date
            ? `GREATEST(membership_start_date, CURRENT_DATE) + INTERVAL '31 days'`
            : `CURRENT_DATE + INTERVAL '31 days'`;
        await dbClient.query(`UPDATE users SET membership_start_date = ${newMembershipDate} WHERE chat_id = $1`, [chatId]);
        if (referralId) {
            await dbClient.query(`UPDATE users SET membership_start_date = membership_start_date + INTERVAL '10 days' WHERE chat_id = $1`, [referralId]);
            console.log(`🎁 Referral bonus of 10 days added to user: ${referralId}`);
            const membershipInfo = getMembershipInfo(null, null, referralId);
            if (membershipInfo.isLifetime) {
                await sendSolReward(chatId, referralId);
            }
            await checkReferralMilestone(referralId);
        }
        await bot.sendMessage(chatId, "🎟 Your membership has been successfully activated!");
    } catch (error) {
        console.error("❌ Error updating membership:", error);
    }
}

async function checkSolTransaction(txId, chatId) {
    try {
        const heliusApiKey = "2851f503-261c-484b-b98c-75f87e56759a";
        console.log(`🔄 Checking transaction ${txId} via Helius API...`);
        const response = await axios.post(`https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`, {
            jsonrpc: "2.0",
            id: 1,
            method: "getTransaction",
            params: [txId, { commitment: "confirmed" }]
        }, { timeout: 5000 });
        if (response.data && response.data.result && response.data.result.meta && response.data.result.meta.confirmationStatus === "confirmed") {
            console.log(`✅ Transaction ${txId} confirmed!`);
            await updateUserMembership(chatId, null, bot);
            return true;
        } else {
            console.log(`⏳ Transaction ${txId} not yet confirmed. Retrying...`);
            return false;
        }
    } catch (error) {
        console.error("❌ Error checking transaction via Helius:", error);
        return false;
    }
}

async function handlePaymentConfirmation(bot, chatId) {
    console.log(`🔍 Verifying payment for user: ${chatId}`);
    let paymentId = Object.keys(pendingPayments).find(p => pendingPayments[p].chatId === chatId);
    if (!paymentId) {
        console.log(`❌ No active payment session found for user ${chatId}.`);
        await bot.sendMessage(chatId, "⚠️ No active payment session found. Please start the payment process again.");
        return;
    }
    const { solAmount, referralId } = pendingPayments[paymentId];
    const waitMessage = await bot.sendMessage(chatId, "⏳ *Confirming the transaction, please wait...* \n\n This may take a few minutes.", { parse_mode: "Markdown" });
    let paymentConfirmed = false;
    let retries = 5;
    while (!paymentConfirmed && retries > 0) {
        try {
            console.log(`🔄 Checking blockchain for payment of ${solAmount} SOL... (Attempt ${6 - retries}/5)`);
            await listenForSolanaPayment(chatId, bot, solAmount, "DSHKTg2ZBZKWTYQiLY72gtjkjXxeknuzCZdJY3U8pP5i", referralId);
            paymentConfirmed = true;
            break;
        } catch (error) {
            console.error(`❌ Error verifying payment for user ${chatId}:`, error);
            break;
        }
        await new Promise(resolve => setTimeout(resolve, 3000));
        retries--;
    }
    if (paymentConfirmed) {
        console.log(`✅ Payment confirmed for user: ${chatId}`);
        const successMessage = await bot.sendMessage(chatId, "✅ *Payment confirmed! Your membership has been activated.*", { parse_mode: "Markdown" });
        await updateUserMembership(chatId, referralId, bot);
        setTimeout(async () => {
            try {
                if (waitMessage && waitMessage.message_id) await bot.deleteMessage(chatId, waitMessage.message_id);
                if (successMessage && successMessage.message_id) await bot.deleteMessage(chatId, successMessage.message_id);
            } catch (error) {
                console.error("⚠️ Error deleting confirmation messages:", error);
            }
            await clearChat(chatId, messageHistory, bot);
        }, 3000);
    } else {
        console.log(`❌ Payment not found for user: ${chatId}`);
        isAwaitingTxId[chatId] = true;
        await bot.sendMessage(chatId, "❌ *Transaction not found.*\n\nIf you completed the transfer, please enter your *Transaction ID (TXID)* below or contact support.", {
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [[{ text: "🔄 Enter TXID", callback_data: "enter_txid" }], [{ text: "📞 Contact Support", url: "https://t.me/seu_grupo_suporte" }, { text: "⬅️ Back to Menu", callback_data: "back_to_menu" }]] }
        });
    }
}

async function sendSolReward(chatId, referralId) {
    const user = await dbClient.query("SELECT wallet_address FROM users WHERE chat_id = $1", [referralId]);
    if (!user.rows[0]?.wallet_address) return;
    const recipient = user.rows[0].wallet_address;
    const solAmount = 1; // $1 em SOL
    if (WALLET_PRIVATE_KEY) {
        const connection = new Connection("https://api.mainnet-beta.solana.com");
        const fromKeypair = Keypair.fromSecretKey(Uint8Array.from(WALLET_PRIVATE_KEY)); // Substitua por chave segura
        const transaction = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: fromKeypair.publicKey,
                toPubkey: new PublicKey(recipient),
                lamports: solAmount * LAMPORTS_PER_SOL,
            })
        );
        const signature = await connection.sendTransaction(transaction, [fromKeypair]);
        await connection.confirmTransaction(signature);
        console.log(`🎁 $1 SOL sent to ${recipient} for referral by ${chatId} (TX: ${signature})`);
        await dbClient.query("INSERT INTO rewards (chat_id, amount, status, tx_signature) VALUES ($1, $2, 'completed', $3)", [referralId, solAmount, signature]);
    } else {
        console.log(`🎁 Sending $1 SOL to ${recipient} for referral by ${chatId} (pending manual processing)`);
        await dbClient.query("INSERT INTO rewards (chat_id, amount, status) VALUES ($1, $2, 'pending')", [referralId, solAmount]);
    }
}

async function checkReferralMilestone(chatId) {
    const count = await dbClient.query("SELECT COUNT(*) FROM referrals WHERE referrer_id = $1 AND status = 'success'", [chatId]);
    if (parseInt(count.rows[0].count, 10) >= 20) {
        await dbClient.query("UPDATE users SET membership_start_date = '1988-10-01' WHERE chat_id = $1", [chatId]);
        bot.sendMessage(chatId, "🎉 Congrats! You've reached 20 referrals and earned Lifetime Membership!");
    }
}

module.exports = {
    handleMembershipCommand,
    handleSolPayment,
    handlePaymentConfirmation,
    generateSolanaPayLink,
    listenForSolanaPayment,
    checkSolTransaction,
    processReferralInput,
    updateUserMembership, // Make sure this and all other functions you intend to export are listed
    getMembershipInfo, // <- Ensure this line is present and correctly spelled
};
