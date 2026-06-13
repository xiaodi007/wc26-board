import { readFileSync, writeFileSync } from "node:fs";
import {
  WALRUS_ENABLED,
  WALRUS_EPOCHS,
  WALRUS_NETWORK,
  WALRUS_PUBLISHER_URL,
} from "./config.js";
import { setMeta } from "./db.js";
import { exportWalrusFeed, publicArtifact, WALRUS_SCHEMA_VERSION, type WalrusArtifact } from "./exports/walrusFeed.js";

interface PublishedBlob {
  blobId: string;
  objectId: string | null;
  raw: unknown;
}

function publisherBase(): string {
  const raw = WALRUS_PUBLISHER_URL.trim().replace(/\/+$/, "");
  if (!raw) throw new Error("WALRUS_PUBLISHER_URL is required for publish");
  return raw;
}

function pickString(raw: unknown, paths: string[][]): string | null {
  for (const path of paths) {
    let value: unknown = raw;
    for (const key of path) value = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
    if (typeof value === "string" && value) return value;
  }
  return null;
}

function parsePublishResponse(raw: unknown): PublishedBlob {
  const blobId = pickString(raw, [
    ["newlyCreated", "blobObject", "blobId"],
    ["alreadyCertified", "blobId"],
    ["blobId"],
  ]);
  if (!blobId) throw new Error(`Walrus publish response did not include a blob id: ${JSON.stringify(raw).slice(0, 500)}`);
  const objectId = pickString(raw, [
    ["newlyCreated", "blobObject", "id"],
    ["alreadyCertified", "event", "blobObject", "id"],
    ["objectId"],
  ]);
  return { blobId, objectId, raw };
}

async function publishFile(artifact: WalrusArtifact): Promise<PublishedBlob> {
  const url = `${publisherBase()}/v1/blobs?epochs=${encodeURIComponent(String(WALRUS_EPOCHS))}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { "content-type": artifact.contentType },
    body: readFileSync(artifact.path),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) throw new Error(`Walrus publish failed for ${artifact.relativePath}: HTTP ${res.status} ${text.slice(0, 500)}`);
  return parsePublishResponse(json);
}

async function main(): Promise<void> {
  if (!WALRUS_ENABLED) {
    throw new Error("WALRUS_ENABLED=true is required for publish. Use npm run export:walrus for local-only export.");
  }

  const exported = exportWalrusFeed();
  const publishedArtifacts = [];
  for (const artifact of exported.artifacts.filter((a) => a.relativePath !== "manifest-latest.json")) {
    const published = await publishFile(artifact);
    publishedArtifacts.push({ ...publicArtifact(artifact), walrus: { blob_id: published.blobId, object_id: published.objectId } });
    console.log(`walrus publish: ${artifact.relativePath} -> ${published.blobId}`);
  }

  const manifest = {
    ...exported.manifest,
    walrus_network: WALRUS_NETWORK,
    walrus_epochs: WALRUS_EPOCHS,
    artifacts: publishedArtifacts,
  };
  writeFileSync(exported.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const manifestArtifact = exported.artifacts.find((artifact) => artifact.relativePath === "manifest-latest.json");
  if (!manifestArtifact) throw new Error("manifest-latest.json artifact missing");
  const publishedManifest = await publishFile(manifestArtifact);

  setMeta("walrus_latest_manifest_blob_id", publishedManifest.blobId);
  if (publishedManifest.objectId) setMeta("walrus_latest_manifest_object_id", publishedManifest.objectId);
  setMeta("walrus_latest_published_at", new Date().toISOString());
  setMeta("walrus_latest_network", WALRUS_NETWORK);
  setMeta("walrus_latest_schema_version", WALRUS_SCHEMA_VERSION);
  setMeta("walrus_latest_error", "");
  console.log(`walrus publish: manifest -> ${publishedManifest.blobId}`);
}

main().catch((e) => {
  const message = e instanceof Error ? e.message : String(e);
  setMeta("walrus_latest_error", message.slice(0, 500));
  console.error(`walrus publish: ${message}`);
  process.exitCode = 1;
});
