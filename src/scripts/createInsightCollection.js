const { loadEnv } = require("../config/env");
const { DotdigitalClient } = require("../clients/dotdigitalClient");

function getArgs() {
  const [, , collectionNameArg, collectionScopeArg, collectionTypeArg] = process.argv;

  const collectionName = collectionNameArg || process.env.DOTDIGITAL_COLLECTION_NAME;
  const collectionScope = (collectionScopeArg || process.env.DOTDIGITAL_COLLECTION_SCOPE || "contact").toLowerCase();
  const collectionType = collectionTypeArg || process.env.DOTDIGITAL_COLLECTION_TYPE || "custom";

  if (!collectionName) {
    console.error("Usage: npm run create:insightdata -- <collectionName> [collectionScope] [collectionType]");
    console.error("Example: npm run create:insightdata -- orders contact custom");
    process.exit(1);
  }

  if (!["account", "contact"].includes(collectionScope)) {
    console.error('Invalid collectionScope. Use "account" or "contact".');
    process.exit(1);
  }

  return {
    collectionName,
    collectionScope,
    collectionType
  };
}

async function createInsightCollection() {
  const env = loadEnv();
  const apiOrigin = new URL(env.baseUrl).origin;
  const { collectionName, collectionScope, collectionType } = getArgs();

  const client = new DotdigitalClient({
    baseUrl: env.baseUrl,
    username: env.username,
    password: env.password
  });

  const encodedName = encodeURIComponent(collectionName);
  const endpoint = `${apiOrigin}/insightData/v3/collections/${encodedName}`;

  const response = await client.request({
    method: "POST",
    url: endpoint,
    params: {
      collectionScope,
      collectionType
    }
  });

  console.log("Insight Data collection create request succeeded.");
  console.log(`collectionName=${collectionName}`);
  console.log(`collectionScope=${collectionScope}`);
  console.log(`collectionType=${collectionType}`);

  if (response) {
    console.log("Response:");
    console.log(JSON.stringify(response, null, 2));
  }
}

createInsightCollection().catch((error) => {
  console.error("Failed to create Insight Data collection:", error.message);
  process.exit(1);
});
