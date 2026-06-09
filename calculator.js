(() => {
    const MONTHS_PER_YEAR = 12;
    const DEFAULT_START = '1957-01';

    function toRate(value) {
        return Number(value || 0) / 100;
    }

    function round(value, digits = 2) {
        const base = 10 ** digits;
        return Math.round((Number(value) + Number.EPSILON) * base) / base;
    }

    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }

    function hashSeed(seed) {
        let h = 2166136261;
        const text = String(seed || 'sp500');
        for (let i = 0; i < text.length; i++) {
            h ^= text.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return h >>> 0;
    }

    function createRng(seed) {
        let state = hashSeed(seed);
        return () => {
            state += 0x6D2B79F5;
            let t = state;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function percentile(sortedValues, p) {
        if (!sortedValues.length) return 0;
        const index = (sortedValues.length - 1) * p;
        const lower = Math.floor(index);
        const upper = Math.ceil(index);
        if (lower === upper) return sortedValues[lower];
        return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (index - lower);
    }

    function summarize(values) {
        const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
        const mean = sorted.reduce((sum, value) => sum + value, 0) / Math.max(sorted.length, 1);
        return {
            min: sorted[0] || 0,
            p10: percentile(sorted, 0.1),
            p25: percentile(sorted, 0.25),
            median: percentile(sorted, 0.5),
            p75: percentile(sorted, 0.75),
            p90: percentile(sorted, 0.9),
            max: sorted[sorted.length - 1] || 0,
            mean
        };
    }

    function buildPlan(inputPlan) {
        return inputPlan.map((item) => ({
            invest: Math.max(Number(item.invest || 0), 0),
            withdraw: Math.max(Number(item.withdraw || 0), 0)
        }));
    }

    function getMarketData() {
        const source = window.SP500_SHILLER_MONTHLY || { monthly: [] };
        const monthly = source.monthly
            .filter((item) => Number.isFinite(item.nominalReturn))
            .map((item) => ({
                date: item.date,
                nominalReturn: Number(item.nominalReturn),
                realReturn: Number(item.realReturn),
                cpi: Number(item.cpi)
            }));
        return { ...source, monthly };
    }

    function getDataMeta() {
        const data = getMarketData();
        return {
            source: data.source || '',
            downloadedAt: data.downloadedAt || '',
            start: data.start || '',
            end: data.end || '',
            rows: data.rows || 0
        };
    }

    function buildOptions(inputOptions) {
        const data = getMarketData();
        return {
            annualReturn: toRate(inputOptions.annualReturn),
            inflationRate: toRate(inputOptions.inflationRate),
            managementFee: toRate(inputOptions.managementFee),
            transactionFee: toRate(inputOptions.transactionFee),
            simulations: clamp(Math.floor(Number(inputOptions.simulations || 2000)), 200, 10000),
            seed: inputOptions.seed || 'sp500',
            historyStart: inputOptions.historyStart || DEFAULT_START,
            historyEnd: inputOptions.historyEnd || data.end,
            returnAdjustment: toRate(inputOptions.returnAdjustment),
            data
        };
    }

    function filterMonthlyReturns(options) {
        return options.data.monthly.filter((item) => {
            return item.date >= options.historyStart && item.date <= options.historyEnd;
        });
    }

    function netMonthlyReturn(marketReturn, options) {
        return ((1 + marketReturn) * Math.exp(-options.managementFee / MONTHS_PER_YEAR)) - 1;
    }

    function adjustedMonthlyReturn(marketReturn, options) {
        const monthlyAdjustment = Math.expm1(Math.log1p(options.returnAdjustment) / MONTHS_PER_YEAR);
        return ((1 + marketReturn) * (1 + monthlyAdjustment)) - 1;
    }

    function deterministicMonthlyReturn(options) {
        return Math.expm1(Math.log1p(options.annualReturn) / MONTHS_PER_YEAR);
    }

    function solveMonthlyIrr(flows) {
        const hasPositive = flows.some((flow) => flow.amount > 0);
        const hasNegative = flows.some((flow) => flow.amount < 0);
        if (!hasPositive || !hasNegative) return null;

        const npv = (rate) => flows.reduce((sum, flow) => {
            return sum + flow.amount / ((1 + rate) ** flow.month);
        }, 0);
        const candidates = [-0.9999, -0.95, -0.75, -0.5, -0.25, -0.1, -0.05, -0.02, -0.01, 0, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5];

        for (let i = 0; i < candidates.length - 1; i++) {
            let low = candidates[i];
            let high = candidates[i + 1];
            let lowValue = npv(low);
            let highValue = npv(high);
            if (!Number.isFinite(lowValue) || !Number.isFinite(highValue)) continue;
            if (lowValue === 0) return low;
            if (highValue === 0) return high;
            if (lowValue * highValue > 0) continue;

            for (let step = 0; step < 100; step++) {
                const mid = (low + high) / 2;
                const midValue = npv(mid);
                if (Math.abs(midValue) < 1e-7) return mid;
                if (lowValue * midValue <= 0) {
                    high = mid;
                    highValue = midValue;
                } else {
                    low = mid;
                    lowValue = midValue;
                }
            }
            return (low + high) / 2;
        }

        return null;
    }

    function annualizeMonthlyRate(monthlyRate) {
        if (monthlyRate === null || !Number.isFinite(monthlyRate) || monthlyRate <= -1) return null;
        return ((1 + monthlyRate) ** MONTHS_PER_YEAR) - 1;
    }

    function simulatePath(plan, options, monthlyMarketReturnFactory, label = '') {
        const cashFlows = [];
        const yearly = [];
        const monthly = [];
        const totalMonths = plan.length * MONTHS_PER_YEAR;
        let asset = 0;
        let totalInvested = 0;
        let totalWithdrawn = 0;
        let totalTradeCost = 0;
        let maxAsset = 0;
        let maxDrawdown = 0;

        for (let year = 0; year < plan.length; year++) {
            const startAsset = asset;
            let invested = 0;
            let yearlyTradeCost = 0;

            for (let monthInYear = 0; monthInYear < MONTHS_PER_YEAR; monthInYear++) {
                const month = year * MONTHS_PER_YEAR + monthInYear;
                const invest = plan[year].invest;
                const netInvest = invest / (1 + options.transactionFee);
                const tradeCost = invest - netInvest;
                const marketReturn = monthlyMarketReturnFactory(month);

                totalInvested += invest;
                invested += invest;
                totalTradeCost += tradeCost;
                yearlyTradeCost += tradeCost;
                asset += netInvest;
                cashFlows.push({ month, amount: -invest });

                asset *= 1 + netMonthlyReturn(marketReturn, options);
                maxAsset = Math.max(maxAsset, asset);
                maxDrawdown = maxAsset > 0 ? Math.min(maxDrawdown, asset / maxAsset - 1) : 0;
                monthly.push({
                    month: month + 1,
                    year: Math.ceil((month + 1) / MONTHS_PER_YEAR),
                    asset,
                    principal: totalInvested - totalWithdrawn,
                    profit: asset + totalWithdrawn - totalInvested,
                    realAsset: asset / ((1 + options.inflationRate) ** ((month + 1) / MONTHS_PER_YEAR))
                });
            }

            const withdrawn = Math.min(plan[year].withdraw, Math.max(asset, 0));
            asset -= withdrawn;
            totalWithdrawn += withdrawn;
            if (withdrawn > 0) {
                cashFlows.push({ month: (year + 1) * MONTHS_PER_YEAR, amount: withdrawn });
                monthly[monthly.length - 1].asset = asset;
                monthly[monthly.length - 1].principal = totalInvested - totalWithdrawn;
                monthly[monthly.length - 1].profit = asset + totalWithdrawn - totalInvested;
            }

            yearly.push({
                year: year + 1,
                startAsset,
                invested,
                tradeCost: yearlyTradeCost,
                withdrawn,
                endAsset: asset,
                principal: totalInvested - totalWithdrawn,
                profit: asset + totalWithdrawn - totalInvested,
                realAsset: asset / ((1 + options.inflationRate) ** (year + 1))
            });
        }

        cashFlows.push({ month: totalMonths, amount: asset });
        const mwr = annualizeMonthlyRate(solveMonthlyIrr(cashFlows));
        const years = Math.max(plan.length, 1);
        return {
            label,
            totalInvested,
            totalWithdrawn,
            totalTradeCost,
            totalProfit: asset + totalWithdrawn - totalInvested,
            finalAsset: asset,
            realPurchasingPower: asset / ((1 + options.inflationRate) ** years),
            mwr,
            maxDrawdown,
            yearly,
            monthly
        };
    }

    function summarizeYears(paths, years) {
        return Array.from({ length: years }, (_, yearIndex) => {
            const endAsset = paths.map((path) => path.yearly[yearIndex].endAsset);
            const principal = paths.map((path) => path.yearly[yearIndex].principal);
            const profit = paths.map((path) => path.yearly[yearIndex].profit);
            const realAsset = paths.map((path) => path.yearly[yearIndex].realAsset);
            return {
                year: yearIndex + 1,
                endAsset: summarize(endAsset),
                principal: summarize(principal),
                profit: summarize(profit),
                realAsset: summarize(realAsset)
            };
        });
    }

    function buildDistribution(paths) {
        const finalAssets = paths.map((path) => path.finalAsset);
        const realAssets = paths.map((path) => path.realPurchasingPower);
        const profits = paths.map((path) => path.totalProfit);
        const mwrs = paths.map((path) => path.mwr).filter((value) => value !== null && Number.isFinite(value));
        const drawdowns = paths.map((path) => path.maxDrawdown);
        const finalAsset = summarize(finalAssets);
        return {
            finalAsset,
            realPurchasingPower: summarize(realAssets),
            totalProfit: summarize(profits),
            mwr: mwrs.length ? summarize(mwrs) : null,
            maxDrawdown: summarize(drawdowns),
            profitProbability: paths.filter((path) => path.totalProfit > 0).length / paths.length,
            realPrincipalProbability: paths.filter((path) => path.realPurchasingPower > path.totalInvested - path.totalWithdrawn).length / paths.length
        };
    }

    function representativePath(paths, target) {
        return paths.reduce((closest, path) => {
            return Math.abs(path.finalAsset - target) < Math.abs(closest.finalAsset - target)
                ? path
                : closest;
        }, paths[0]);
    }

    function buildResult(mode, plan, options, paths, modelInfo) {
        const distribution = buildDistribution(paths);
        const representative = representativePath(paths, distribution.finalAsset.median);
        const summary = {
            ...representative,
            finalAsset: distribution.finalAsset.median,
            realPurchasingPower: distribution.realPurchasingPower.median,
            totalProfit: distribution.totalProfit.median,
            mwr: distribution.mwr ? distribution.mwr.median : null,
            maxDrawdown: distribution.maxDrawdown.median
        };

        return {
            mode,
            options,
            summary,
            timeline: representative.monthly,
            distribution,
            yearly: summarizeYears(paths, plan.length),
            modelInfo
        };
    }

    function calculateFixed(inputPlan, inputOptions) {
        const plan = buildPlan(inputPlan);
        const options = buildOptions(inputOptions);
        const monthlyReturn = deterministicMonthlyReturn(options);
        const path = simulatePath(plan, options, () => monthlyReturn, '固定收益');
        return buildResult('fixed', plan, options, [path], {
            title: '固定收益测算',
            detail: '每月使用同一个年化收益率折算后的月收益，不模拟市场波动。'
        });
    }

    function calculateRandom(inputPlan, inputOptions) {
        const plan = buildPlan(inputPlan);
        const options = buildOptions(inputOptions);
        const pool = filterMonthlyReturns(options);
        const paths = Array.from({ length: options.simulations }, (_, index) => {
            const rng = createRng(`${options.seed}:${index}`);
            return simulatePath(plan, options, () => {
                const sample = pool[Math.floor(rng() * pool.length)];
                return adjustedMonthlyReturn(sample.nominalReturn, options);
            }, `随机路径 ${index + 1}`);
        });
        return buildResult('random', plan, options, paths, {
            title: '随机市场模拟',
            detail: `从 ${options.historyStart} 到 ${options.historyEnd} 的历史月度总回报中随机抽样，生成 ${options.simulations} 条未来路径。`,
            sampleCount: pool.length
        });
    }

    function calculateHistory(inputPlan, inputOptions) {
        const plan = buildPlan(inputPlan);
        const options = buildOptions(inputOptions);
        const pool = filterMonthlyReturns(options);
        const totalMonths = plan.length * MONTHS_PER_YEAR;
        const windows = Math.max(pool.length - totalMonths + 1, 0);
        const paths = Array.from({ length: windows }, (_, startIndex) => {
            const start = pool[startIndex];
            const end = pool[startIndex + totalMonths - 1];
            return simulatePath(plan, options, (month) => {
                return adjustedMonthlyReturn(pool[startIndex + month].nominalReturn, options);
            }, `${start.date} 至 ${end.date}`);
        });
        return buildResult('history', plan, options, paths, {
            title: '历史区间参考',
            detail: `遍历 ${options.historyStart} 到 ${options.historyEnd} 中所有连续 ${plan.length} 年窗口，共 ${windows} 段。`,
            sampleCount: pool.length,
            windows
        });
    }

    window.Calculator = {
        calculateFixed,
        calculateRandom,
        calculateHistory,
        getDataMeta,
        round
    };
})();
