export const DEFAULT_GATEWAY_HTTP_URL = "http://127.0.0.1:8787";

export function getGatewayHttpUrl(): string {
  const configured = process.env.NEXT_PUBLIC_VLM_GATEWAY_URL;
  const raw = configured && configured.trim() ? configured.trim() : DEFAULT_GATEWAY_HTTP_URL;
  return raw.replace(/\/$/, "");
}

export function getGatewayWsUrl(): string {
  const httpUrl = getGatewayHttpUrl();
  if (httpUrl.startsWith("https://")) {
    return `wss://${httpUrl.slice("https://".length)}`;
  }
  if (httpUrl.startsWith("http://")) {
    return `ws://${httpUrl.slice("http://".length)}`;
  }
  throw new Error("NEXT_PUBLIC_VLM_GATEWAY_URL must be an http or https URL");
}

export function getRealtimeUrl(): string {
  return `${getGatewayWsUrl()}/v1/realtime`;
}

export function getCatalogUrl(): string {
  return `${getGatewayHttpUrl()}/v1/models`;
}
