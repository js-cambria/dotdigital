const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const { loadEnv } = require("../config/env");
const { DotdigitalClient } = require("../clients/dotdigitalClient");
const { InsightDataService } = require("../services/insightDataService");

const DEFAULT_CONTACT_IDENTIFIER = "jacob.stapleton@cambriaautos.co.uk";
const DEFAULT_COLLECTION_NAME = "Vehicles";
const DEFAULT_SCHEMA_PATH = "data/insight/schemas/insight/dd_Vehicles_schema.csv";
const DEFAULT_RECORD_ID = "VEHICLE_TEST_001";

function getArgs() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const positionalArgs = args.filter((arg) => !arg.startsWith("--"));

  return {
    apply,
    contactIdentifier: positionalArgs[0] || DEFAULT_CONTACT_IDENTIFIER,
    collectionName: positionalArgs[1] || DEFAULT_COLLECTION_NAME,
    schemaPath: path.resolve(positionalArgs[2] || DEFAULT_SCHEMA_PATH),
    recordId: positionalArgs[3] || DEFAULT_RECORD_ID
  };
}

function readSchemaRows(schemaPath) {
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`Schema CSV not found: ${schemaPath}`);
  }

  const content = fs.readFileSync(schemaPath, "utf8");
  const rows = parse(content, {
    columns: false,
    skip_empty_lines: true,
    trim: true
  });

  return rows.map((row, index) => {
    const line = index + 1;
    const [fieldName, sqlType, maxLength, precision, scale] = row;

    if (!fieldName || !sqlType) {
      throw new Error(`Invalid schema row at line ${line}: expected fieldName and SQL type.`);
    }

    return {
      line,
      fieldName: String(fieldName).trim(),
      sqlType: String(sqlType).trim().toLowerCase(),
      maxLength: Number.isFinite(Number(maxLength)) ? Number(maxLength) : null,
      precision: Number.isFinite(Number(precision)) ? Number(precision) : null,
      scale: Number.isFinite(Number(scale)) ? Number(scale) : null
    };
  });
}

function truncateString(value, maxLength) {
  if (!maxLength || value.length <= maxLength) {
    return value;
  }

  return value.slice(0, maxLength);
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function buildNumericValue(row) {
  if (row.scale && row.scale > 0) {
    return Number((12345.67).toFixed(row.scale));
  }

  return 12345;
}

function buildStringValue(row) {
  const name = row.fieldName.toUpperCase();

  if (name.includes("REGISTRATION_NUMBER")) {
    return truncateString("AB12CDE", row.maxLength);
  }

  if (name === "VIN") {
    return truncateString("WVWZZZ1JZXW000001", row.maxLength);
  }

  if (name.endsWith("_DATE")) {
    return truncateString(todayIsoDate(), row.maxLength);
  }

  if (name.includes("MAKE")) {
    return truncateString("Volkswagen", row.maxLength);
  }

  if (name.includes("MODEL")) {
    return truncateString("Golf", row.maxLength);
  }

  if (name.includes("COLOUR")) {
    return truncateString("Blue", row.maxLength);
  }

  if (name.endsWith("_KEY") || name.endsWith("_UID") || name.includes("ENGINE_NUMBER")) {
    return truncateString("11111111-1111-1111-1111-111111111111", row.maxLength);
  }

  return truncateString(`TEST_${row.fieldName}`, row.maxLength);
}

function buildFieldValue(row) {
  if (["numeric", "decimal", "int", "bigint", "smallint", "tinyint", "float", "real", "money"].includes(row.sqlType)) {
    return buildNumericValue(row);
  }

  if (["bit", "boolean"].includes(row.sqlType)) {
    return true;
  }

  if (["date", "datetime", "datetime2", "smalldatetime", "timestamp"].includes(row.sqlType)) {
    return todayIsoDate();
  }

  return buildStringValue(row);
}

function buildRecordData(schemaRows) {
  const data = {};

  for (const row of schemaRows) {
    data[row.fieldName] = buildFieldValue(row);
  }

  return data;
}

async function importTestVehicleInsightRecord() {
  const { apply, contactIdentifier, collectionName, schemaPath, recordId } = getArgs();
  const env = loadEnv();
  const apiOrigin = new URL(env.baseUrl).origin;

  const client = new DotdigitalClient({
    baseUrl: env.baseUrl,
    username: env.username,
    password: env.password
  });

  const insightData = new InsightDataService(client);
  const schemaRows = readSchemaRows(schemaPath);
  const data = buildRecordData(schemaRows);

  console.log(`Contact identifier: ${contactIdentifier}`);
  console.log(`Collection: ${collectionName}`);
  console.log(`Schema file: ${schemaPath}`);
  console.log(`Record ID: ${recordId}`);
  console.log(`Fields in record: ${Object.keys(data).length}`);

  if (!apply) {
    console.log("Dry run only. Re-run with --apply to import the test vehicle record.");
    console.log("Payload preview:");
    console.log(
      JSON.stringify(
        {
          contactIdentifier,
          collectionName,
          recordId,
          data
        },
        null,
        2
      )
    );
    return;
  }

  const v3Endpoint = `${apiOrigin}/insightData/v3/contacts/email/${encodeURIComponent(contactIdentifier)}/${encodeURIComponent(collectionName)}/${encodeURIComponent(recordId)}`;

  try {
    await client.request({
      method: "PUT",
      url: v3Endpoint,
      data
    });
  } catch (error) {
    const message = String(error.message || "");

    if (!message.includes("(404)")) {
      throw error;
    }

    // Fallback for legacy accounts still serving older Insight Data routes.
    await insightData.upsertContactRecord({
      contactIdentifier,
      collectionName,
      recordId,
      data
    });
  }

  console.log("Test vehicle insight data record import completed.");
}

importTestVehicleInsightRecord().catch((error) => {
  console.error("Failed to import test vehicle insight data record:", error.message);
  process.exit(1);
});