window.Calculator = {
    generateNormalRandom: function(mean, stdDev) {
        let u1 = Math.random();
        let u2 = Math.random();
        while (u1 === 0) u1 = Math.random();
        while (u2 === 0) u2 = Math.random();
        const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
        return z0 * stdDev + mean;
    },
    calculateIRR: function(cashFlows, guess = 0.1) {
        let rate = guess;
        for (let i = 0; i < 100; i++) {
            let npv = 0;
            let dnpv = 0;
            for (let t = 0; t < cashFlows.length; t++) {
                const factor = Math.pow(1 + rate, t + 1);
                npv += cashFlows[t] / factor;
                dnpv -= (t + 1) * cashFlows[t] / (factor * (1 + rate));
            }
            if (dnpv === 0) return rate;
            const newRate = rate - npv / dnpv;
            if (Math.abs(newRate - rate) < 1e-6) return newRate;
            rate = newRate;
        }
        return rate;
    },
    simulateInvestment: function(plan, annualRate, volatility) {
        const rateDec = annualRate / 100;
        const volDec = volatility / 100;
        const monthlyExpectedReturn = rateDec / 12;
        const monthlyVolatility = volDec / Math.sqrt(12);

        let totalAsset = 0;
        let cashFlows = [];
        const yearImpact = [];
        let twrFactor = 1.0;

        for (let i = 0; i < plan.length; i++) {
            const monthlyInvest = plan[i].invest;
            const withdrawYear = plan[i].withdraw;
            
            let asset = totalAsset;
            const startOfYearAsset = asset;

            for (let m = 0; m < 12; m++) {
                let actualMonthlyRate = monthlyExpectedReturn;
                if (volatility > 0) {
                    actualMonthlyRate = this.generateNormalRandom(monthlyExpectedReturn, monthlyVolatility);
                }
                
                twrFactor *= (1 + actualMonthlyRate);
                asset = asset * (1 + actualMonthlyRate) + monthlyInvest;
            }

            asset -= withdrawYear;

            const net = monthlyInvest * 12 - withdrawYear;
            const extraProfit = asset - startOfYearAsset - net;

            yearImpact.push({
                net: net,
                assetImpact: net + extraProfit,
                extraProfit: extraProfit
            });

            cashFlows.push(-(monthlyInvest * 12));
            if (withdrawYear > 0) cashFlows.push(withdrawYear);

            totalAsset = asset;
        }

        const years = plan.length;
        let annualizedTWR = 0;
        if (years > 0) {
             annualizedTWR = (Math.pow(twrFactor, 1 / years) - 1) * 100;
        }

        const mwr = this.calculateIRR(cashFlows) * 100;

        const totalInvested = plan.reduce((sum, p) => sum + p.invest * 12, 0);
        const totalWithdrawn = plan.reduce((sum, p) => sum + p.withdraw, 0);
        const totalProfit = totalAsset - totalInvested + totalWithdrawn;

        return {
            totalInvested,
            totalWithdrawn,
            totalProfit,
            finalAsset: totalAsset,
            yearImpact: yearImpact,
            twr: annualizedTWR,
            mwr: mwr
        };
    }
};
