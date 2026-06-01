const { loadEnv } = require("../config/env");
const { DotdigitalClient } = require("../clients/dotdigitalClient");
function normalizeCollectionsResponse(response) {
  if (Array.isArray(response)) {
    return response;
  }

  if (Array.isArray(response?.items)) {
    return response.items;
  }

  if (Array.isArray(response?.records)) {
    return response.records;
  }

  return [];
}

async function listInsightCollections() {
  const env = loadEnv();
  const apiOrigin = new URL(env.baseUrl).origin;

  const client = new DotdigitalClient({
    baseUrl: env.baseUrl,
    username: env.username,
    password: env.password
  });

  let response;

  try {
    response = await client.get(`${apiOrigin}/insightData/v3/collections`);
  } catch (error) {
    const message = String(error.message || "");

    if (!message.includes("(404)")) {
      throw error;
    }

    // Fallback for older endpoint naming in legacy accounts.
    response = await client.get("/insightdata");
  }

  const collections = normalizeCollectionsResponse(response);

  if (collections.length === 0) {
    console.log("No Insight Data collections found.");
    return;
  }

  console.log(`Insight Data collections (${collections.length}):`);

  for (const collection of collections) {
    const name =
      collection?.collectionName || collection?.name || collection?.key || "(unnamed collection)";
    const scope = collection?.collectionScope || collection?.scope || "unknown-scope";
    const type = collection?.collectionType || collection?.type || "unknown-type";
    const recordCount =
      typeof collection?.recordCount === "number" ? collection.recordCount : "unknown-record-count";
    console.log(`- ${name} [scope=${scope}, type=${type}]`);
    console.log(`  records=${recordCount}`);
  }
}

listInsightCollections().catch((error) => {
  console.error("Failed to list Insight Data collections:", error.message);
  process.exit(1);
});
