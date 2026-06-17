import { WALRUS_AGGREGATOR_URL, WALRUS_NETWORK } from "./config.js";

export function walrusBlobJsonUrl(blobId: string | null | undefined): string | null {
  if (!blobId) return null;
  const base = WALRUS_AGGREGATOR_URL.trim().replace(/\/+$/, "");
  return base ? `${base}/v1/blobs/${encodeURIComponent(blobId)}` : null;
}

export function walrusExplorerUrl(blobId: string | null | undefined, network = WALRUS_NETWORK): string | null {
  if (!blobId) return null;
  const net = network.trim() || "testnet";
  return `https://walruscan.com/${encodeURIComponent(net)}/blobs/${encodeURIComponent(blobId)}`;
}

export function walrusArtifactLinks(blobId: string | null | undefined, network = WALRUS_NETWORK): { jsonUrl: string | null; explorerUrl: string | null } {
  return {
    jsonUrl: walrusBlobJsonUrl(blobId),
    explorerUrl: walrusExplorerUrl(blobId, network),
  };
}
