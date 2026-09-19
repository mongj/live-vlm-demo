import { parseGatewayAddress } from "@/lib/gateway";

export async function GET(request: Request) {
  const origin = parseGatewayAddress(new URL(request.url).searchParams.get("origin") ?? "");
  const catalogUrl = `${origin}/v1/models`;

  try {
    const response = await fetch(catalogUrl, { cache: "no-store" });
    const body = await response.text();
    return new Response(body, {
      status: response.status,
      headers: {
        "content-type": response.headers.get("content-type") ?? "application/json",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to reach the gateway Catalog";
    return Response.json({ error: message }, { status: 502 });
  }
}
