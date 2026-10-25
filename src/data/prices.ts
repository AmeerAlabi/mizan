// Market price snapshot. The chart endpoint is unofficial, so every run stores what it used
// (price, time, source) and the screen cites that snapshot rather than a live number.
export interface PriceSnapshot {
  ticker: string;
  price: number;
  currency: string;
  capturedAt: string;
  marketTime: string;
  source: string;
}

export async function fetchPrice(ticker: string): Promise<PriceSnapshot> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=1d`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`price ${res.status} for ${ticker}`);
  const meta = (await res.json())?.chart?.result?.[0]?.meta;
  if (!meta?.regularMarketPrice) throw new Error(`no price for ${ticker}`);
  return {
    ticker,
    price: meta.regularMarketPrice,
    currency: meta.currency,
    capturedAt: new Date().toISOString(),
    marketTime: new Date(meta.regularMarketTime * 1000).toISOString(),
    source: `yahoo-chart:${url}`,
  };
}
