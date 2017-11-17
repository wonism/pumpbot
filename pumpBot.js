var bittrex = require('node.bittrex.api');
let config = require('./config');
const readline = require('readline');
let _ = require('lodash');
var buyOrderPoll;
var sellPoll;
var sellOrderPoll;
let shares;
let availableBTC;
/**
* read-only key
**/
bittrex.options({
  'apikey' : '',
  'apisecret' : '',
});

/**
* trade/read key
**/
// bittrex.options({
//   'apikey' : '',
//   'apisecret' : '',
// });

if(!process.argv[2]) {
  console.log(`usage: pumpBot <coin abbreviation> <shares to purchase>`);
  //console.log(`eg: pumpBot ZEN 1000`);
  exit();
}
let coinPrice;
let latestAsk;
let filledPrice;
const coin = 'BTC-' + process.argv[2];
if(process.argv.length >=3) {
   shares = process.argv[3];
}


bittrex.getbalance({ currency : 'BTC' },( data, err ) => {
  if(err) {
    exit(`something went wrong with getBalance: ${err.message}`);
  }
  availableBTC = data.result.Available;
  getCoinStats();
});

/**
* getCoinStats - retrieves the current bid/ask/last for the given coin
**/
function getCoinStats() {
  bittrex.getticker( { market : coin },( data, err ) => {
    if(err) {
      exit(`something went wrong with getTicker: ${err.message}`);
    } else {
      console.log(`current Ask: ${displaySats(data.result.Ask)}`);
      console.log(`current Bid: ${displaySats(data.result.Bid)}`);
      console.log(`Last price:  ${displaySats(data.result.Last)}`);
      coinPrice = data.result.Ask + (data.result.Ask * config.market_buy_inflation);
      latestAsk = data.result.Ask;
      checkCandle();
    }
  });
}
/**
* checkCandle - retrieves the history of the given coin and compares the candle change to the configurable % change
**/
function checkCandle() {
  bittrex.getcandles({
    marketName: coin,
    tickInterval: 'oneMin'
  }, function(data, err) {
    if (err) {
      return exit(`something went wrong with getCandles: ${err.message}`);
    }
    let candles = _.takeRight(data.result,config.no_buy_threshold_time);
    let highAskDelta = (1.00-(candles[0].H/latestAsk)) * 100;
    //if we meet the threshold criteria, go ahead
    if(highAskDelta < (config.no_buy_threshold_percentage * 100)) {
      console.log(`${coin} has a ${highAskDelta.toFixed(2)}% gain/loss in the past ${data.result,config.no_buy_threshold_time} minutes`);
      if(!shares) {
        shares = (availableBTC * config.investment_percentage)/latestAsk;
      }
      showPrompt();
    } else {
      exit(`${coin} has increased past the ${config.no_buy_threshold_percentage * 100}% threshold (at ${highAskDelta.toFixed(2)}%), no buy will be made.`);
    }
  });
}

/**
* showPrompt - present a yes/no to the user whether they'd like to continue with the purchase
**/
function showPrompt() {
  if(!config.disable_prompt) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question(`Are you sure you want to purchase ${shares} ${coin} at ${coinPrice.toFixed(8)}?\n`, (answer) => {
      if(answer === 'yes' || answer === 'y') {
        purchase();
      } else {
        rl.close();
      }
    });
  } else {
    purchase();
  }
}

/**
* pollOrder - poll the purchase order until it is filled
**/
function pollOrder(orderUUID) {
  console.log(`uuid: ${orderUUID}`);
  var buyOrderPoll = setInterval(() => {
    bittrex.getorder({uuid: orderUUID}, (data,err) => {
      if(err) {
        exit(`something went wrong with getOrderBuy: ${err.message}`);
      } else {
        console.log(data);
        if(data.result.isOpen) {
          console.log(`order not yet filled`);
        } else if(data.result.CancelInitiated) {
          exit(`order cancel was initiated by user`);
        } else {
          if(config.auto_sell) {
            filledPrice = data.result.PricePerUnit;
            console.log(`ORDER FILLED at ${displaySats(data.result.PricePerUnit)}!`);
            clearInterval(buyOrderPoll);
            sellPoll = setInterval(sell, 8000);
          } else {
            exit(`ORDER FILLED at ${displaySats(data.result.PricePerUnit)}!`);
          }
        }
      }
    });
  },2000);
}

/**
* purchase - initiates the purchase order for the coin
**/
function purchase() {
  if(config.fake_buy) {
    filledPrice = latestAsk;
    console.log(`ORDER FILLED at ${displaySats(filledPrice)}!`);
    sellPoll = setInterval(sell, 8000);
  } else {
    bittrex.buylimit({market: coin, quantity: shares, rate: coinPrice}, (data,err) => {
      if(err) {
        exit(`something went wrong with buyLimit: ${err.message}`);
      } else {
        pollOrder(data.result.uuid);
      }
    });
  }
}

function pollForSellComplete(uuid) {
  var sellOrderPoll = setInterval(() => {
    bittrex.getorder({uuid: uuid}, (data,err) => {
      if(err) {
        exit(`something went wrong with getOrderSell: ${err.message}`);
      } else {
        if(data.result.isOpen) {
          console.log(`sell order not filled yet`);
        } else if(data.result.CancelInitiated) {
          exit(`sell order cancel was initiated by user`);
        } else {
          clearInterval(sellOrderPoll);
          exit(`SELL ORDER FILLED at ${displaySats(data.result.Price)}!`);
        }
      }
    });
  },2000);
}

function sell() {
  let average_price = 0;
  let total_price = 0;
  let total_volume = 0;
  let count = 1;
  let sellPrice = 0;
  let purchasedVolume = shares;
  let gainSum = 0;

  console.log(`polling for ${config.desired_return * 100}% return`);
  bittrex.getorderbook({market: coin,type: 'buy'}, (data,err) => {
    if(err) {
      exit(`something went wrong with getOrderBook: ${err.message}`);
    } else {
      sellPrice = data.result[0].Rate;
      console.log(`Evaluating selling at ${displaySats(sellPrice)}`);
      _.forEach(data.result, (order) => {
        //is initial volume higher than purchased volume?
        if(order.Quantity <= purchasedVolume) {
          let gain = (order.Quantity * order.Rate) / (filledPrice * order.Quantity) - 1;
          gainSum+= gain;
          purchasedVolume-= order.Quantity;
          count++;
        } else {
          let gain = (order.Rate * purchasedVolume) / (filledPrice * purchasedVolume) - 1;
          gainSum+= gain;
          let avgGain = (gainSum/count) * 100;
          console.log(`total gain on trade: ${avgGain.toFixed(2)}%`);

          if(avgGain >= (config.desired_return * 100)) {
            console.log(`SELLING FOR ${displaySats(sellPrice)}`);
            bittrex.selllimit({market: coin, quantity: shares, rate: sellPrice}, (data,err) => {
              if(err) {
                exit(`something went wrong with sellLimit: ${err.message}`);
              } else {
                clearInterval(sellPoll);
                pollForSellComplete(data.result.uuid);
              }
            });
            return false;
          } else {
            console.log(`GAIN DOES NOT PASS CONFIGURED THRESHOLD, NOT SELLING`);
            return false;
          }
        }
      });
    }
  });
}

function exit(message) {
  if(message) {
    console.log(message);
  }
  process.exit();
}

function displaySats(number) {
  return number.toFixed(8);
}