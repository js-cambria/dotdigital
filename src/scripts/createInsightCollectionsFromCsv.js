const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const { loadEnv } = require("../config/env");
const { DotdigitalClient } = require("../clients/dotdigitalClient");

function readSchemaCsv(csvPath) {
  if (!fs.existsSync(csvPath)) {
    throw new Error(`Schema CSV not found: ${csvPath}`);
  }

  const content = fs.readFileSync(csvPath, "utf8");
  const rows = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true
  });

  return rows.map((row, index) => {
    const line = index + 2;
    const collectionName = row.collectionName;
    const collectionScope = (row.collectionScope || "").toLowerCase();
    const collectionType = row.collectionType;

    if (!collectionName || !collectionScope || !collectionType) {
      throw new Error(
        `Invalid schema row at line ${line}: collectionName, collectionScope, and collectionType are required.`
      );
    }

    if (!["account", "contact"].includes(collectionScope)) {
      throw new Error(`Invalid collectionScope at line ${line}: ${collectionScope}`);
    }

    return {
      collectionName,
      collectionScope,
      collectionType
    };
  });
}

async function createCollections() {
  const env = loadEnv();
  const apiOrigin = new URL(env.baseUrl).origin;
  const schemaPathArg = process.argv[2] || "data/insight/schemas/collections.csv";
  const schemaPath = path.resolve(schemaPathArg);
  const rows = readSchemaCsv(schemaPath);

  const client = new DotdigitalClient({
    baseUrl: env.baseUrl,
    username: env.username,
    password: env.password
  });

  if (rows.length === 0) {
    console.log("No schema rows found. Nothing to create.");
    return;
  }

  console.log(`Creating collections from: ${schemaPath}`);

  for (const row of rows) {
    const endpoint = `${apiOrigin}/insightData/v3/collections/${encodeURIComponent(row.collectionName)}`;
    await client.request({
      method: "POST",
      url: endpoint,
      params: {
        collectionScope: row.collectionScope,
        collectionType: row.collectionType
      }
    });

    console.log(
      `Created or already exists: ${row.collectionName} [scope=${row.collectionScope}, type=${row.collectionType}]`
    );
  }
}

createCollections().catch((error) => {
  console.error("Failed to create collections from CSV:", error.message);
  process.exit(1);
});
