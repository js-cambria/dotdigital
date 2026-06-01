const readline = require("readline");
const { loadEnv } = require("../config/env");
const { DotdigitalClient } = require("../clients/dotdigitalClient");

function parseArgs() {
  const args = process.argv.slice(2);
  let collectionName;
  let skipConfirmation = false;

  for (const arg of args) {
    if (arg === "--yes" || arg === "-y") {
      skipConfirmation = true;
      continue;
    }

    if (!collectionName) {
      collectionName = arg;
    }
  }

  collectionName = collectionName || process.env.DOTDIGITAL_COLLECTION_NAME;

  if (!collectionName) {
    console.error("Usage: npm run delete:insightdata -- <collectionName> [--yes]");
    process.exit(1);
  }

  return {
    collectionName,
    skipConfirmation
  };
}

async function requestConfirmation(collectionName) {
  if (!process.stdin.isTTY) {
    console.error("Interactive confirmation is unavailable. Re-run with --yes to confirm deletion.");
    process.exit(1);
  }

  const expected = `DELETE ${collectionName}`;
  const prompt = `Type \"${expected}\" to confirm deletion: `;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const answer = await new Promise((resolve) => {
    rl.question(prompt, resolve);
  });

  rl.close();

  return answer.trim() === expected;
}

async function deleteInsightCollection() {
  const env = loadEnv();
  const apiOrigin = new URL(env.baseUrl).origin;
  const { collectionName, skipConfirmation } = parseArgs();

  const client = new DotdigitalClient({
    baseUrl: env.baseUrl,
    username: env.username,
    password: env.password
  });

  if (!skipConfirmation) {
    const confirmed = await requestConfirmation(collectionName);
    if (!confirmed) {
      console.log("Deletion cancelled.");
      return;
    }
  }

  const endpoint = `${apiOrigin}/insightData/v3/collections/${encodeURIComponent(collectionName)}`;

  await client.request({
    method: "DELETE",
    url: endpoint
  });

  console.log("Insight Data collection deleted.");
  console.log(`collectionName=${collectionName}`);
}

deleteInsightCollection().catch((error) => {
  console.error("Failed to delete Insight Data collection:", error.message);
  process.exit(1);
});
