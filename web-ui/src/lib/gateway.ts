// Browser traffic stays on the frontend origin; Next.js proxies /v1 to FastAPI.
export function getRealtimeUrl(): string {
  const url = new URL("/v1/realtime", window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function getCatalogUrl(): string {
  return "/v1/models";
}
