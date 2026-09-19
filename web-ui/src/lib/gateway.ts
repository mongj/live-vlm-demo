export const DEFAULT_GATEWAY_ADDRESS = "127.0.0.1:8787";
const DEFAULT_GATEWAY_ORIGIN = "http://127.0.0.1:8787";

function trimTrailingSlash(url: string): string {
  return url.replace(/\/$/, "");
}

function getServerGatewayOrigin(): string {
  const configured = process.env.VLM_GATEWAY_URL?.trim();
  const origin = configured && configured.length > 0 ? configured : DEFAULT_GATEWAY_ORIGIN;
  return trimTrailingSlash(origin);
}

function hasUriScheme(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value);
}

function toHttpProtocol(protocol: string): "http:" | "https:" {
  if (protocol === "https:" || protocol === "wss:") {
    return "https:";
  }
  return "http:";
}

export function parseGatewayAddress(address: string): string {
  const trimmed = address.trim();
  if (trimmed.length === 0) {
    return DEFAULT_GATEWAY_ORIGIN;
  }

  const candidate = hasUriScheme(trimmed) ? trimmed : `http://${trimmed}`;

  try {
    const url = new URL(candidate);
    const protocol = toHttpProtocol(url.protocol);
    switch (protocol) {
      case "http:":
        url.protocol = "http:";
        break;
      case "https:":
        url.protocol = "https:";
        break;
      default: {
        const exhaustive: never = protocol;
        return exhaustive;
      }
    }
    return trimTrailingSlash(url.origin);
  } catch {
    return DEFAULT_GATEWAY_ORIGIN;
  }
}

export function getGatewayCatalogUrl(gatewayAddress?: string): string {
  if (typeof window === "undefined" && gatewayAddress === undefined) {
    return `${getServerGatewayOrigin()}/v1/models`;
  }
  return `${parseGatewayAddress(gatewayAddress ?? DEFAULT_GATEWAY_ADDRESS)}/v1/models`;
}

export function getCatalogUrl(gatewayAddress?: string): string {
  if (typeof window === "undefined") {
    return getGatewayCatalogUrl();
  }
  const origin = parseGatewayAddress(gatewayAddress ?? DEFAULT_GATEWAY_ADDRESS);
  return `/api/catalog?origin=${encodeURIComponent(origin)}`;
}

export function getRealtimeUrl(gatewayAddress?: string): string {
  const origin = parseGatewayAddress(gatewayAddress ?? DEFAULT_GATEWAY_ADDRESS);
  const url = new URL("/v1/realtime", origin);
  const protocol = toHttpProtocol(url.protocol);
  switch (protocol) {
    case "https:":
      url.protocol = "wss:";
      break;
    case "http:":
      url.protocol = "ws:";
      break;
    default: {
      const exhaustive: never = protocol;
      return exhaustive;
    }
  }
  return url.toString();
}
