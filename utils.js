const pendingPayments = {};

function getMembershipInfo(membershipStartDate, trialStartDate) {
    const now = new Date();
    const lifetimeAccessDate = new Date("1988-10-01"); // 📌 Data para acesso vitalício

    // 📌 Se a data do membership for 01-10-1988, retorna acesso vitalício
    if (membershipStartDate && new Date(membershipStartDate).getTime() === lifetimeAccessDate.getTime()) {
        return { isActive: true, isLifetime: true };
    }

    // 📌 Se o usuário tem uma membership ativa (menos de 31 dias desde a ativação)
    if (membershipStartDate) {
        const startDate = new Date(membershipStartDate);
        const diffDays = (now - startDate) / (1000 * 60 * 60 * 24);
        const roundedDaysRemaining = Math.round(31 - diffDays); // ✅ Agora arredondando corretamente!
        if (roundedDaysRemaining > 0) {
            return { isActive: true, isLifetime: false, daysRemaining: roundedDaysRemaining };
        }
    }

    // 📌 Se ainda está no período de Free Trial (5 dias)
    if (trialStartDate) {
        const startDate = new Date(trialStartDate);
        const diffDays = (now - startDate) / (1000 * 60 * 60 * 24);
        const roundedDaysRemaining = Math.round(5 - diffDays); // ✅ Agora arredondando corretamente!
        if (roundedDaysRemaining > 0) {
            return { isActive: true, isLifetime: false, isTrial: true, daysRemaining: roundedDaysRemaining };
        }
    }

    // 📌 Caso contrário, membership expirou
    return { isActive: false, isLifetime: false, daysRemaining: 0 };
}



module.exports = { getMembershipInfo, pendingPayments };

