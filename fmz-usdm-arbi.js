
// 5 seconds
const MAX_ORDER_WAIT_TIME = 5000;
// trade 100u for each round, to minimize price impact
const VALUE_EACH_ROUND = 100;
// 交易手续费预留，现货手续费 0.075%，合约手续费 0.05%，总手续费 0.125%，预留 0.5%，以防价格波动导致合约下单因为保证金不够失败。
const TRADE_BUFFER = 1.005;
let CONTRACT_SIZE = 10;
// 7 天
const FUNDING_PERIOD = 7 * 24 * 60 * 60 * 1000;
const EIGHT_HOURS = 8 * 1000 * 60 * 60;

const INIT_VALUE = 10_000;
function main() {
    // const [spotEx, coinmEx] = exchanges;
    // Log(spotMarkets);
    // Log('markets')
    // Log(Object.entries(coinmMarkets).filter(([key, mkt]) => mkt.QuoteAsset !== 'USDT').map(([key, mkt]) => mkt));

    // setPrceisions(exchanges, [spotName(), coinmFutureName()]);
    // if (OPNE_POSITION) {
    //     openArbitrage(spotEx, coinmEx);
    // } else {
    //     closeArbitrage(spotEx, coinmEx);
    // }
    monitor()
}

function monitor() {
    const [spotEx, coinmEx] = exchanges;
    let lastRecordTime = undefined;
    let [spotMarkets, coinmMarkets] = getMarkets([spotEx, coinmEx]);
    while (true) {
        const now = new Date();
        // record every 8 hours at the first minute
        if (!lastRecordTime || (now.valueOf() - lastRecordTime >= EIGHT_HOURS && now.getMinutes() === 1)) {
            lastRecordTime = now.valueOf();
            const avgFundingRates = getAvgFundingRates(coinmMarkets, coinmEx);
            // logFundiongRates(avgFundingRates);
            Log('funding rates')
            Log(avgFundingRates.slice(0, 10));
            Log('positions')
            let positions = getCoinmPositions(coinmMarkets, coinmEx);
            reinvest(coinmEx, positions);
            // get positions again after reinvesting
            positions = getCoinmPositions(coinmMarkets, coinmEx);
            const assetsAndValues = getAssetsAndValues(coinmEx);
            Log('assets')
            Log(assetsAndValues)
            const assetsValue = assetsAndValues.reduce((prev, cur) => prev + cur.value, 0);
            const totalValue = positions.reduce((prev, cur) => prev + cur.totalValue, 0);
            const profit = assetsValue + totalValue - INIT_VALUE;
            Log('assetsValue', assetsValue, 'totalValue', totalValue, 'profit', profit);
            // LogProfitReset();
            LogProfit(profit);
            logTable(spotEx, positions, assetsAndValues, avgFundingRates, totalValue);
        }
        Sleep(10000);
    }
}


function reinvest(coinmEx, positions) {
    for (const pos of positions) {
        // TODO: chagne 10 to the correct contract_size
        if (pos.reduceableValue > 10) {
            // TODO: error handling
            reduceMargin(coinmEx, pos.symbol, pos.reduceable);
        }
    }
    const assets = coinmEx.GetAssets();
    for (const asset of assets) {
        const currency = `${asset.Currency}_USD`;
        coinmEx.IO('currency', currency);
        coinmEx.SetContractType("swap");
        const ticker = coinmEx.GetTicker();
        const value = ticker.Buy * asset.Amount;
        // TODO: chagne 10 to the correct contract_size, may remove this check because if value is < 10, order will not be triggered
        if (value >= 10) {
            // TODO: set direaction at an unified place
            coinmEx.SetDirection('sell');
            Log(`reinvesting ${currency}, asset amount: ${asset.Amount}`)
            openShortPosition(coinmEx, asset.Amount);
        }
    }
}

function reduceMargin(coinmEx, symbol, amount) {
    // doc: https://binance-docs.github.io/apidocs/delivery/en/#modify-isolated-position-margin-trade
    const message = `symbol=${symbol}&amount=${amount}&type=2&timestamp=${new Date().valueOf()}`;
    return coinmEx.IO('api', 'POST', '/dapi/v1/positionMargin', message);
}

function formatPercent(value) {
    return `${(value * 100).toFixed(3)}%`
}
function logTable(spotEx, positions, assetValues, avgFundingRates, totalPositionValue) {
    const findAssetValue = (currency) => {
        const aseetValue = assetValues.find(av => av.currency === currency);
        if (aseetValue) return aseetValue.value;
        return 0;
    }
    const findPos = (currency) => {
        return positions.find(p => p.currency === currency);
    }
    let rows = avgFundingRates.map(fr => {
        const pos = findPos(fr.currency);
        const posValue = pos ? pos.positionValue.toFixed(3) : 0;
        const assetValue = pos ? findAssetValue(fr.currency) : 0;
        const profit = pos ? (pos.reduceableValue + assetValue).toFixed(3) : 0;
        const nextRate = formatPercent(fr.nextFundingRate);
        const avgRate = formatPercent(fr.avgRate);
        const dailyEst = formatPercent(fr.avgRate * 3);
        const yearlyEst = formatPercent(fr.avgRate * 3 * 365);
        return [fr.currency, posValue, profit, nextRate, avgRate, dailyEst, yearlyEst];
    })
    rows = rows.sort((a, b) => Number(b[1]) - Number(a[1]));
    const frTable = { 
        type: 'table', 
        title: '币本位合约', 
        cols: ['Symbol', '仓位价值', '收益', '下一次资金费率', '近7天平均费率', '估算日化', '估算年化'], 
        rows
    }
    const assets = spotEx.GetAssets();
    Log('assets', assets);
    const usdtAsset = assets.find(a => a.Currency === 'USDT')
    const usdtBalance = usdtAsset ? usdtAsset.Amount : 0;
    const accountTable = { 
        type: 'table', 
        title: '账户信息', 
        cols: ['现货 USDT 余额', '币本位仓位总价值', '初始资金', '目前总资金', '收益率'], 
        rows: [[usdtBalance.toFixed(3), totalPositionValue.toFixed(3), INIT_VALUE, (usdtBalance + totalPositionValue).toFixed(3), formatPercent((usdtBalance + totalPositionValue)/INIT_VALUE - 1)]]
    }
    LogStatus('`' + JSON.stringify(accountTable) + '`\n`' + JSON.stringify(frTable)+ '`')
}

function getAssetsAndValues(coinmEx) {
    const assets = coinmEx.GetAssets();
    return assets.map(asset => {
        const currency = `${asset.Currency}_USD`;
        coinmEx.IO('currency', currency);
        coinmEx.SetContractType("swap");
        const ticker = coinmEx.GetTicker();
        const value = ticker.Last * asset.Amount;
        return {...asset, currency, value}
    })
}

function getCoinmPositions(coinmMarkets, coinmEx) {
    const positions = [];
    Object.entries(coinmMarkets).filter(([key, mkt]) => mkt.Symbol.endsWith('USD_PERP')).forEach(([key, mkt]) => {
        const currency = `${mkt.BaseAsset}_${mkt.QuoteAsset}`
        // Log('set currency to', currency);
        coinmEx.IO('currency', currency);
        coinmEx.SetContractType("swap");
        // Log('get positions of', currency);
        const position = coinmEx.GetPosition();
        if (position.length > 0) {
            const pos = position[0];
            Log("Currency", currency, "Amount:", position[0].Amount, "FrozenAmount:", position[0].FrozenAmount, "Price:",
            position[0].Price, "Profit:", position[0].Profit, "Type:", position[0].Type,
            "ContractType:", position[0].ContractType, "Info", position[0].Info)
            const isolatedWallet = pos.Info.isolatedWallet;
            const entryPrice = pos.Info.entryPrice;
            const markPrice = pos.Info.markPrice;
            const unRealizedProfit = pos.Info.unRealizedProfit;
            const postionPnl = unRealizedProfit * markPrice;
            const collateralPnl = isolatedWallet * (markPrice - entryPrice);
            const collateralValue = isolatedWallet * markPrice;
            // const positionValue = collateralValue + postionPnl;
            const positionValue = pos.Amount * mkt.Info.contractSize;
            const reduceable = isolatedWallet - positionValue / entryPrice;
            const reduceableValue = reduceable * markPrice;
            const totalValue = reduceableValue + positionValue;
            const totalValue2 = collateralValue + postionPnl;
            const symbol = mkt.Symbol;
            Log("currency", currency, 'symbol', symbol, "positionPnl", postionPnl, 'collateralPnl', collateralPnl, 'collateralValue', collateralValue, 'positionValue', positionValue, 'reduceable', reduceable, 'reduceableValue', reduceableValue, 'totalValue', totalValue, 'totalValue2', totalValue2);
            positions.push({...pos, currency, symbol, positionValue, markPrice, reduceable, reduceableValue, totalValue, totalValue2});
        }
    })
    return positions;
}

function getUSDPerps(coinmMarkets) {
    return Object.entries(coinmMarkets).filter(([key, mkt]) => mkt.Symbol.endsWith('USD_PERP'));
}

function getNextFundingRates(coinmEx) {
    // return type Array<{symbol: string, lastFundingRate: number, nextFundingTime: number}>
    return coinmEx.IO('api', 'GET', '/dapi/v1/premiumIndex'); 
}

function getAvgFundingRates(coinmMarkets, coinmEx) {
    let history =  getUSDPerps(coinmMarkets).map(([key, mkt]) => {
        const endTime = (new Date()).valueOf();
        const startTime = endTime - FUNDING_PERIOD;
        // return type Array<{symbol: string, fundingTime: number, fundingRate: number, markPrice: number}>
        const rates = getFundingRates(coinmEx, mkt.Symbol, startTime, endTime);
        // Log(rates);
        const avgRate = rates.reduce((prev, cur) => prev + Number(cur.fundingRate), 0) / rates.length;
        const currency = `${mkt.BaseAsset}_${mkt.QuoteAsset}`
        return {currency: currency, symbol: mkt.Symbol, avgRate};
    });
    const nextFundingRates = getNextFundingRates(coinmEx);
    history = history.map(h => {
        const nextFr = nextFundingRates.find(nfr => nfr.symbol === h.symbol);
        const nextFundingRate = nextFr ? nextFr.lastFundingRate : 0;
        return {...h, nextFundingRate}
    })
    // high avgRate in the front
    return history.sort((a, b) => b.avgRate - a.avgRate);
}

function getFundingRates(coinmEx, symbol, startTime, endTime) {
    const message = `symbol=${symbol}&startTime=${startTime.toString()}&endTime=${endTime.toString()}`
    // return type Array<{symbol: string, fundingTime: number, fundingRate: number, markPrice: number}>
    return coinmEx.IO('api', 'GET', '/dapi/v1/fundingRate', message);

}

function getMarkets(exchanges) {
    return exchanges.map(ex => ex.GetMarkets())
}

function openArbitrage(spotEx, coinmEx) {
    // value too small
    if (TRADE_VALUE < VALUE_EACH_ROUND) return;
    coinmEx.SetContractType("swap");
    setIsolated(coinmEx);
    coinmEx.SetMarginLevel(1);
    coinmEx.SetDirection('sell');
    const rounds = Math.floor(TRADE_VALUE / VALUE_EACH_ROUND);
    for (let i = 0; i < rounds; i++ ) {
        Log(`open arbitrage round ${i + 1}`)
        buySpot(spotEx, coinmEx);
        Sleep(500);
        const stocks = transferToFutures(spotEx);
        Sleep(500);
        openShortPosition(coinmEx, stocks);
    }
}

function closeArbitrage(spotEx, coinmEx) {
    coinmEx.SetContractType("swap");
    const positions = coinmEx.GetPosition();

    if (positions.length > 0 ) {
        const pos = positions[0];
        const rounds = Math.floor(pos.Amount * CONTRACT_SIZE / VALUE_EACH_ROUND) + 1;
        for (let i = 0; i < rounds; i++) {
            Log(`close arbitrage round ${i + 1}`)
            closeShortPosition(coinmEx);
            Sleep(500);
            transferToSpot(spotEx, coinmEx);
            Sleep(500);
            sellSpot(spotEx);
            Sleep(500);
        }
    }
}

// 每个交易对的价格和数量精度不一样，设置精度
function setPrceisions(exchanges, names) {
    for (let i = 0; i < exchanges.length; i++) {
        const ex = exchanges[i];
        const mkts = ex.GetMarkets();
        // Log(mkts);
        const mkt = mkts[names[i]];
        ex.SetPrecision(mkt.PricePrecision, mkt.AmountPrecision);
        if (i === 1) {
            CONTRACT_SIZE = mkt.Info.contractSize;
        }
    }
}

function buySpot(spotEx, coimEx) {
    const account = spotEx.GetAccount();
    if (account.Stocks > 0) return;
    // use coinm price rather than spot price to get enough stocks
    const getPrice = (ex) => coimEx.GetTicker().Sell;
    const getAmount = (price) => {
        return VALUE_EACH_ROUND * TRADE_BUFFER / price;
    }

    const tradeF = (ex, price, amount) => ex.Buy(price, amount);

    waitOrder(spotEx, getPrice, getAmount, tradeF);
}

function sellSpot(spotEx) {
    const account = spotEx.GetAccount();
    if (account.Stocks == 0) return;
    const getPrice = (ex) => ex.GetTicker().Buy;
    const getAmount = (price) => {
        return account.Stocks;
    }

    const tradeF = (ex, price, amount) => ex.Sell(price, amount);

    waitOrder(spotEx, getPrice, getAmount, tradeF);
}

function transferToFutures(spotEx) {
    const asset = getAssetName();
    const stocks = spotEx.GetAccount().Stocks;
    Log(`asset: ${asset}, stocks: ${stocks}`)
    if (stocks > 0) {
        // https://binance-docs.github.io/apidocs/spot/en/#user-universal-transfer-user_data
        const message = `type=MAIN_CMFUTURE&asset=${asset}&amount=${stocks}&timestamp=${(new Date().valueOf())}`;
        spotEx.IO('api', 'POST', '/sapi/v1/asset/transfer', message);
    }
    return stocks;
}

function transferToSpot(spotEx, coinmEx) {
    const asset = getAssetName();
    let stocks = coinmEx.GetAccount().Stocks;
    Log(`asset: ${asset}, stocks: ${stocks}`)
    // BNB cannot transfer all out, bug?
    if (ASSET_NAME === 'BNB') {
        stocks = stocks * 0.98;
    }
    if (stocks > 0) { 
        // https://binance-docs.github.io/apidocs/spot/en/#user-universal-transfer-user_data
        const message = `type=CMFUTURE_MAIN&asset=${asset}&amount=${stocks}&timestamp=${(new Date().valueOf())}`;
        spotEx.IO('api', 'POST', '/sapi/v1/asset/transfer', message);
    }
    return stocks;
}

function openShortPosition(coinmEx, stocks) {
    if (stocks > 0) {
        const getPrice = (ex) => ex.GetTicker().Buy;

        const getAmount = (price) => {
            return Math.floor(price * stocks / CONTRACT_SIZE);
        }
        const tradeF = (ex, price, amount) => ex.Sell(price, amount);

        waitOrder(coinmEx, getPrice, getAmount, tradeF);
    }
}

function closeShortPosition(coinmEx) {
    coinmEx.SetContractType("swap");
    const positions = coinmEx.GetPosition();

    const amountEachRound = VALUE_EACH_ROUND / CONTRACT_SIZE;

    if (positions.length > 0 ) {
        const pos = positions[0];
        // cancel any potentail orders
        coinmEx.SetDirection('buy');

        const getPrice = (ex) => ex.GetTicker().Sell;
        const getAmount = (price) => pos.Amount > amountEachRound ? amountEachRound : pos.Amount;
        const tradeF = (ex, price, amount) => ex.Buy(price, amount);
        waitOrder(coinmEx, getPrice, getAmount, tradeF);
    }
}


function setIsolated(coinmEx) {
    const symbol = coinmEx.GetTicker().Info.symbol;
    const message = `symbol=${symbol}&marginType=ISOLATED&timestamp=${(new Date().valueOf())}`;
    coinmEx.IO('api', 'POST', '/dapi/v1/marginType', message);
}

function orderClosed(order) {
    return ORDER_STATE_CLOSED == order.Status;
}

function spotName() {
    return `${ASSET_NAME}_USDT`;
}

function coinmFutureName() {
    return futureSymbol(ASSET_NAME);
}

function futureSymbol(asset) {
    return `${asset}_USD.swap`;
}

// asset name is like BTC, fmz symbol name is BTC_USD.swap, binance symbol is like BTCUSD_PERP
function getAssetName() {
    // const ticker = spotEx.GetTicker();
    // let symbol = ticker.Symbol;
    // if (symbol && symbol.includes('_')) {
    //     // eg. return BTC for BTC_USDT
    //     return symbol.split('_')[0];
    // }
    // symbol = ticker.Info.symbol;
    // if (symbol) return symbol.slice(0, symbol.length - 'USDT'.length);
    return ASSET_NAME;
}

function waitOrder(ex, getPrice, getAmount, tradeFunc) {
    while (true) {
        const price = getPrice(ex);
        const amount = getAmount(price);
        if (amount === 0) return;
        const id = tradeFunc(ex, price, amount);
        let waited = 0;
        // 等订单成交
        while (true) {
            const order = ex.GetOrder(id);
            if (!order || orderClosed(order)) return;
            if (waited >= MAX_ORDER_WAIT_TIME) {
                // 如果很久没成交，取消订单，重新挂买单
                ex.CancelOrder(id);
                break;
            }
            waited += 200;
            // 等 200 毫秒
            Sleep(200);
        }
    } 
}
