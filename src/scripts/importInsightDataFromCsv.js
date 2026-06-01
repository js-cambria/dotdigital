const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const { loadEnv } = require("../config/env");
const { DotdigitalClient } = require("../clients/dotdigitalClient");
const { InsightDataService } = require("../services/insightDataService");

function parseCsv(csvPath) {
  if (!fs.existsSync(csvPath)) {
    return [];
  }

  const content = fs.readFileSync(csvPath, "utf8");
  return parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true
  });
}

function parseSchemaRows(schemaPath) {
  const rows = parseCsv(schemaPath);

  return rows.map((row, index) => {
    const line = index + 2;
    const collectionName = row.collectionName;
    const collectionScope = (row.collectionScope || "").toLowerCase();

    if (!collectionName || !collectionScope) {
      throw new Error(`Invalid schema row at line ${line}: collectionName and collectionScope are required.`);
    }

    if (!["account", "contact"].includes(collectionScope)) {
      throw new Error(`Invalid collectionScope at line ${line}: ${collectionScope}`);
    }

    return {
      collectionName,
      collectionScope
    };
  });
}

function parseValue(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }

  const value = String(raw).trim();

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }

  if ((value.startsWith("{") && value.endsWith("}")) || (value.startsWith("[") && value.endsWith("]"))) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  return value;
}

function buildData(row, reservedKeys) {
  const data = {};

  for (const [key, raw] of Object.entries(row)) {
    if (reservedKeys.has(key)) {
      continue;
    }

    data[key] = parseValue(raw);
  }

  return data;
}

async function importCsvData() {
  const env = loadEnv();
  const schemaPathArg = process.argv[2] || "data/insight/schemas/collections.csv";
  const recordsDirArg = process.argv[3] || "data/insight/records";
  const dryRun = process.argv.includes("--dry-run");

  const schemaPath = path.resolve(schemaPathArg);
  const recordsDir = path.resolve(recordsDirArg);
  const schemaRows = parseSchemaRows(schemaPath);

  const client = new DotdigitalClient({
    baseUrl: env.baseUrl,
    username: env.username,
    password: env.password
  });

  const insightData = new InsightDataService(client);
  let importedCount = 0;

  console.log(`Reading schema from: ${schemaPath}`);
  console.log(`Reading record files from: ${recordsDir}`);

  for (const schema of schemaRows) {
    const csvFile = path.join(recordsDir, `${schema.collectionName}.csv`);
    const rows = parseCsv(csvFile);

    if (rows.length === 0) {
      console.log(`Skipping ${schema.collectionName}: no record CSV at ${csvFile} or file is empty.`);
      continue;
    }

    console.log(`Importing ${rows.length} rows for ${schema.collectionName} (${schema.collectionScope})`);

    for (const [index, row] of rows.entries()) {
      const rowNumber = index + 2;
      const recordId = row.recordId;

      if (!recordId) {
        throw new Error(`${schema.collectionName}.csv line ${rowNumber}: recordId is required.`);
      }

      if (schema.collectionScope === "contact") {
        const contactIdentifier = row.contactIdentifier;
        if (!contactIdentifier) {
          throw new Error(
            `${schema.collectionName}.csv line ${rowNumber}: contactIdentifier is required for contact collections.`
          );
        }

        const data = buildData(row, new Set(["recordId", "contactIdentifier"]));

        if (dryRun) {
          console.log(
            `[DRY RUN] upsertContactRecord collection=${schema.collectionName} recordId=${recordId} contactIdentifier=${contactIdentifier}`
          );
        } else {
          await insightData.upsertContactRecord({
            contactIdentifier,
            collectionName: schema.collectionName,
            recordId,
            data
          });
        }
      } else {
        const data = buildData(row, new Set(["recordId"]));

        if (dryRun) {
          console.log(
            `[DRY RUN] upsertAccountRecord collection=${schema.collectionName} recordId=${recordId}`
          );
        } else {
          await insightData.upsertAccountRecord({
            collectionName: schema.collectionName,
            recordId,
            data
          });
        }
      }

      importedCount += 1;
    }
  }

  if (dryRun) {
    console.log(`Dry run complete. ${importedCount} rows validated.`);
  } else {
    console.log(`Import complete. ${importedCount} rows upserted.`);
  }
}

importCsvData().catch((error) => {
  console.error("Failed to import Insight Data from CSV:", error.message);
  process.exit(1);
});
