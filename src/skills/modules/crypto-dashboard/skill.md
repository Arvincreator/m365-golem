# Crypto Dashboard

讀取並刷新 Dashboard「加密貨幣分析」看板快照，提供幣對行情、技術指標、市場廣度與新聞脈絡，讓 Golem 可以根據結構化資料回答幣市分析問題。

## 使用時機

- 使用者要求分析 Dashboard 加密貨幣分析頁、幣市看板或 `/cryptoboard` 資料。
- 使用者詢問 BTC/ETH/SOL 等幣對行情、技術指標、新聞脈絡、強弱輪動或 watchlist 概況。
- 使用者提到交易對，例如 `BTC-USDT`、`ETH-USDC`、`SOL-USDT`，或只輸入 `BTC`、`ETH`。

## Action 格式

```json
{
  "action": "crypto-dashboard",
  "parameters": {
    "symbols": ["BTC-USDT", "ETH-USDC"],
    "selectedSymbol": "BTC-USDT",
    "marketFilter": "crypto",
    "selectedRange": "1D",
    "includeNews": true
  }
}
```

`symbols` 可以省略，系統會使用 Dashboard 預設自選幣。若只輸入 `BTC`，會自動補成 `BTC-USDT`；也接受 `BTCUSDT`、`BTC/USDT` 形式。

## 回覆要求

- 明確說明資料來源是 Dashboard 加密貨幣分析快照，以及資料時間與限制。
- 優先整理幣市概況、強弱幣對、技術指標、新聞脈絡、風險提醒。
- 不要做保證式投資建議，不要承諾報酬，不要把資料不足的推測說成事實。
