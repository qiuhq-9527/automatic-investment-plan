(() => {
    const MONTHS_PER_YEAR = 12;

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
        const text = String(seed || 'dca');
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

    function normalRandom(rng) {
        let u = 0;
        let v = 0;
        while (u === 0) u = rng();
        while (v === 0) v = rng();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
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
        const sorted = values.slice().sort((a, b) => a - b);
        const mean = sorted.reduce((sum, value) => sum + value, 0) / Math.max(sorted.length, 1);
        return {
            min: sorted[0] || 0,
            p5: percentile(sorted, 0.05),
            p10: percentile(sorted, 0.1),
            p25: percentile(sorted, 0.25),
            median: percentile(sorted, 0.5),
            p75: percentile(sorted, 0.75),
            p90: percentile(sorted, 0.9),
            p95: percentile(sorted, 0.95),
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

    function buildOptions(inputOptions) {
        return {
            annualReturn: toRate(inputOptions.annualReturn),
            annualVolatility: toRate(inputOptions.annualVolatility),
            inflationRate: toRate(inputOptions.inflationRate),
            managementFee: toRate(inputOptions.managementFee),
            transactionFee: toRate(inputOptions.transactionFee),
            simulations: clamp(Math.floor(Number(inputOptions.simulations || 2000)), 100, 10000),
            seed: inputOptions.seed || 'sp500'
        };
    }

    function deterministicMonthlyReturn(options) {
        return Math.expm1((Math.log1p(options.annualReturn) - options.managementFee) / MONTHS_PER_YEAR);
    }

    function randomMonthlyReturn(options, rng) {
        const monthlyVolatility = options.annualVolatility / Math.sqrt(MONTHS_PER_YEAR);
        const monthlyLogMean = (Math.log1p(options.annualReturn) - options.managementFee) / MONTHS_PER_YEAR
            - (monthlyVolatility ** 2) / 2;
        return Math.expm1(monthlyLogMean + monthlyVolatility * normalRandom(rng));
    }

    function solveMonthlyIrr(flows) {
        const hasPositive = flows.some((flow) => flow.amount > 0);
        const hasNegative = flows.some((flow) => flow.amount < 0);
        if (!hasPositive || !hasNegative) return null;

        const npv = (rate) => flows.reduce((sum, flow) => {
            return sum + flow.amount / ((1 + rate) ** flow.month);
        }, 0);

        const candidates = [-0.9999, -0.99, -0.95, -0.9, -0.75, -0.5, -0.25, -0.1, -0.05, -0.02, -0.01, 0, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10];
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

    function simulatePath(plan, options, monthlyReturnFactory) {
        const cashFlows = [];
        const yearly = [];
        const monthly = [];
        const totalMonths = plan.length * MONTHS_PER_YEAR;
        let asset = 0;
        let totalInvested = 0;
        let totalWithdrawn = 0;
        let totalTradeCost = 0;
        let twrFactor = 1;

        for (let year = 0; year < plan.length; year++) {
            const startAsset = asset;
            let invested = 0;
            let yearlyTradeCost = 0;

            for (let monthInYear = 0; monthInYear < MONTHS_PER_YEAR; monthInYear++) {
                const month = year * MONTHS_PER_YEAR + monthInYear;
                const invest = plan[year].invest;
                const netInvest = invest / (1 + options.transactionFee);
                const tradeCost = invest - netInvest;
                const monthlyReturn = monthlyReturnFactory(month);

                totalTradeCost += tradeCost;
                yearlyTradeCost += tradeCost;
                totalInvested += invest;
                invested += invest;
                asset += netInvest;
                cashFlows.push({ month, amount: -invest });

                asset *= 1 + monthlyReturn;
                twrFactor *= 1 + monthlyReturn;
                monthly.push({ month: month + 1, asset });
            }

            const requestedWithdraw = plan[year].withdraw;
            const withdrawn = Math.min(requestedWithdraw, Math.max(asset, 0));
            asset -= withdrawn;
            totalWithdrawn += withdrawn;
            if (withdrawn > 0) {
                cashFlows.push({ month: (year + 1) * MONTHS_PER_YEAR, amount: withdrawn });
                monthly[monthly.length - 1].asset = asset;
            }

            yearly.push({
                year: year + 1,
                startAsset,
                invested,
                tradeCost: yearlyTradeCost,
                withdrawn,
                endAsset: asset,
                profit: asset - startAsset - invested + withdrawn
            });
        }

        cashFlows.push({ month: totalMonths, amount: asset });
        const monthlyIrr = solveMonthlyIrr(cashFlows);
        const mwr = annualizeMonthlyRate(monthlyIrr);
        const years = Math.max(plan.length, 1);
        const totalCashOutlay = totalInvested;
        const totalProfit = asset + totalWithdrawn - totalInvested;

        return {
            totalInvested,
            totalWithdrawn,
            totalTradeCost,
            totalCashOutlay,
            totalProfit,
            finalAsset: asset,
            realPurchasingPower: asset / ((1 + options.inflationRate) ** years),
            twr: (twrFactor ** (1 / years)) - 1,
            mwr,
            yearly,
            monthly
        };
    }

    function summarizeYears(paths, years) {
        return Array.from({ length: years }, (_, yearIndex) => {
            const values = paths.map((path) => path.yearly[yearIndex].endAsset);
            const realValues = paths.map((path) => {
                return path.yearly[yearIndex].endAsset / ((1 + path.options.inflationRate) ** (yearIndex + 1));
            });
            return {
                year: yearIndex + 1,
                nominal: summarize(values),
                real: summarize(realValues)
            };
        });
    }

    function buildConfidenceReport({ mode, plan, options, result }) {
        const checks = [];
        const addCheck = (name, status, weight, detail) => {
            checks.push({ name, status, weight, detail });
        };

        const totalInvest = plan.reduce((sum, item) => sum + item.invest * MONTHS_PER_YEAR, 0);
        const hasCashFlow = totalInvest > 0;
        const distribution = result.distribution;
        const dispersion = distribution && distribution.finalAsset.median > 0
            ? distribution.finalAsset.p10 / distribution.finalAsset.median
            : 1;
        const sampleError = distribution && distribution.finalAsset.mean > 0
            ? result.standardError / distribution.finalAsset.mean
            : 0;

        addCheck(
            '现金流有效性',
            hasCashFlow ? 'pass' : 'fail',
            25,
            hasCashFlow ? '存在持续投入，现金流可计算' : '累计投入为 0，结果没有投资含义'
        );
        addCheck(
            '成本口径',
            options.managementFee > 0 || options.transactionFee > 0 ? 'pass' : 'warn',
            15,
            options.managementFee > 0 || options.transactionFee > 0
                ? '已计入年化管理费或场内买入摩擦'
                : '未计入任何费用，长期终值会偏乐观'
        );
        addCheck(
            '通胀口径',
            options.inflationRate > 0 ? 'pass' : 'warn',
            15,
            options.inflationRate > 0 ? '已输出实际购买力' : '通胀为 0，购买力结果偏名义'
        );

        if (mode === 'simulation') {
            addCheck(
                '样本量',
                options.simulations >= 2000 ? 'pass' : options.simulations >= 1000 ? 'warn' : 'fail',
                20,
                `${options.simulations} 条路径`
            );
            addCheck(
                '波动输入',
                options.annualVolatility > 0 ? 'pass' : 'fail',
                15,
                options.annualVolatility > 0 ? '已使用年化波动率生成收益分布' : '波动率为 0，仿真退化为确定性计算'
            );
            addCheck(
                '抽样稳定性',
                sampleError <= 0.015 ? 'pass' : sampleError <= 0.03 ? 'warn' : 'fail',
                10,
                `终值均值标准误约 ${round(sampleError * 100, 2)}%`
            );
            addCheck(
                '结果离散度',
                dispersion >= 0.6 ? 'pass' : dispersion >= 0.4 ? 'warn' : 'fail',
                10,
                `P10/中位数约 ${round(dispersion * 100, 1)}%`
            );
        } else {
            addCheck('路径覆盖', 'warn', 20, '高级模式只展示单一路径，不能衡量极端年份');
        }

        const score = checks.reduce((sum, check) => {
            if (check.status === 'pass') return sum + check.weight;
            if (check.status === 'warn') return sum + check.weight * 0.55;
            return sum;
        }, 0);
        const maxScore = checks.reduce((sum, check) => sum + check.weight, 0);
        const normalizedScore = maxScore ? Math.round((score / maxScore) * 100) : 0;

        return {
            score: normalizedScore,
            grade: normalizedScore >= 85 ? '高' : normalizedScore >= 65 ? '中' : '低',
            checks
        };
    }

    function calculateDeterministic(inputPlan, inputOptions) {
        const plan = buildPlan(inputPlan);
        const options = buildOptions(inputOptions);
        const monthlyReturn = deterministicMonthlyReturn(options);
        const path = simulatePath(plan, options, () => monthlyReturn);
        const result = {
            mode: 'advanced',
            options,
            summary: path,
            timeline: path.monthly,
            yearly: path.yearly.map((item) => ({
                year: item.year,
                p10: item.endAsset,
                median: item.endAsset,
                p90: item.endAsset,
                realMedian: item.endAsset / ((1 + options.inflationRate) ** item.year)
            })),
            distribution: null
        };
        result.confidence = buildConfidenceReport({ mode: 'advanced', plan, options, result });
        return result;
    }

    function calculateSimulation(inputPlan, inputOptions) {
        const plan = buildPlan(inputPlan);
        const options = buildOptions(inputOptions);
        const paths = Array.from({ length: options.simulations }, (_, index) => {
            const rng = createRng(`${options.seed}:${index}`);
            const path = simulatePath(plan, options, () => randomMonthlyReturn(options, rng));
            path.options = options;
            return path;
        });
        const finalAssets = paths.map((path) => path.finalAsset);
        const realAssets = paths.map((path) => path.realPurchasingPower);
        const profits = paths.map((path) => path.totalProfit);
        const mwrs = paths.map((path) => path.mwr).filter((value) => value !== null && Number.isFinite(value));
        const finalDistribution = summarize(finalAssets);
        const mean = finalDistribution.mean;
        const variance = finalAssets.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / Math.max(finalAssets.length - 1, 1);
        const standardError = Math.sqrt(variance) / Math.sqrt(finalAssets.length);
        const representative = paths.reduce((closest, path) => {
            return Math.abs(path.finalAsset - finalDistribution.median) < Math.abs(closest.finalAsset - finalDistribution.median)
                ? path
                : closest;
        }, paths[0]);

        const summary = {
            ...representative,
            finalAsset: finalDistribution.median,
            realPurchasingPower: summarize(realAssets).median,
            totalProfit: summarize(profits).median,
            mwr: mwrs.length ? summarize(mwrs).median : null
        };

        const result = {
            mode: 'simulation',
            options,
            summary,
            timeline: representative.monthly,
            distribution: {
                finalAsset: finalDistribution,
                realPurchasingPower: summarize(realAssets),
                totalProfit: summarize(profits),
                mwr: mwrs.length ? summarize(mwrs) : null,
                profitProbability: paths.filter((path) => path.totalProfit > 0).length / paths.length,
                realPrincipalProbability: paths.filter((path) => path.realPurchasingPower > path.totalCashOutlay).length / paths.length
            },
            yearly: summarizeYears(paths, plan.length).map((item) => ({
                year: item.year,
                p10: item.nominal.p10,
                median: item.nominal.median,
                p90: item.nominal.p90,
                realMedian: item.real.median
            })),
            standardError
        };
        result.confidence = buildConfidenceReport({ mode: 'simulation', plan, options, result });
        return result;
    }

    window.Calculator = {
        calculateDeterministic,
        calculateSimulation,
        round
    };
})();
