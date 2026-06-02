const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const { loadEnv } = require("../config/env");
const { DotdigitalClient } = require("../clients/dotdigitalClient");
const { InsightDataService } = require("../services/insightDataService");

const DEFAULT_CONTACT_IDENTIFIER = "jacob.stapleton@cambriaautos.co.uk";
const DEFAULT_COLLECTION_NAME = "VehicleMarketingEvents";
const DEFAULT_VEHICLE_SCHEMA_PATH = "data/insight/schemas/insight/dd_Vehicles_schema.csv";
const DEFAULT_VEHICLE_DATES_SCHEMA_PATH = "data/insight/schemas/insight/dd_VehicleDates_schema.csv";
const DEFAULT_RECORD_ID = "VEHICLE_MARKETING_EVENT_TEST_001";
const DEFAULT_CRM_VEHICLE_KEY = "11111111-1111-1111-1111-111111111111";

function getArgs() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const positionalArgs = args.filter((arg) => !arg.startsWith("--"));

  return {
    apply,
    contactIdentifier: positionalArgs[0] || DEFAULT_CONTACT_IDENTIFIER,
    collectionName: positionalArgs[1] || DEFAULT_COLLECTION_NAME,
    vehicleSchemaPath: path.resolve(positionalArgs[2] || DEFAULT_VEHICLE_SCHEMA_PATH),
    vehicleDatesSchemaPath: path.resolve(positionalArgs[3] || DEFAULT_VEHICLE_DATES_SCHEMA_PATH),
    recordId: positionalArgs[4] || DEFAULT_RECORD_ID,
    crmVehicleKey: positionalArgs[5] || DEFAULT_CRM_VEHICLE_KEY
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

function buildStringValue(row, crmVehicleKey) {
  const name = row.fieldName.toUpperCase();

  if (name === "CRM_VEHICLE_KEY") {
    return truncateString(crmVehicleKey, row.maxLength);
  }

  if (name.includes("REGISTRATION_NUMBER")) {
    return truncateString("AB12CDE", row.maxLength);
  }

  if (name === "VIN") {
    return truncateString("WVWZZZ1JZXW000001", row.maxLength);
  }

  if (name.endsWith("_DATE") || name === "EVENT_DATE") {
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

  if (name === "EVENT_TYPE") {
    return truncateString("MOT", row.maxLength);
  }

  if (name.includes("ALLOW_") || name.includes("HAS_")) {
    return truncateString("Yes", row.maxLength);
  }

  if (name.endsWith("_KEY") || name.endsWith("_UID") || name.includes("ENGINE_NUMBER")) {
    return truncateString("11111111-1111-1111-1111-111111111111", row.maxLength);
  }

  if (name === "DESCRIPTION") {
    return truncateString("Vehicle marketing event test record", row.maxLength);
  }

  return truncateString(`TEST_${row.fieldName}`, row.maxLength);
}

function buildFieldValue(row, crmVehicleKey) {
  if (["numeric", "decimal", "int", "bigint", "smallint", "tinyint", "float", "real", "money"].includes(row.sqlType)) {
    return buildNumericValue(row);
  }

  if (["bit", "boolean"].includes(row.sqlType)) {
    return true;
  }

  if (["date", "datetime", "datetime2", "smalldatetime", "timestamp"].includes(row.sqlType)) {
    return todayIsoDate();
  }

  return buildStringValue(row, crmVehicleKey);
}

function buildRecordFromSchema(schemaRows, crmVehicleKey) {
  const data = {};

  for (const row of schemaRows) {
    data[row.fieldName] = buildFieldValue(row, crmVehicleKey);
  }

  return data;
}

function combineJoinedRecord(vehicleData, vehicleDatesData) {
  const combined = {
    ...vehicleData
  };

  for (const [key, value] of Object.entries(vehicleDatesData)) {
    if (key === "CRM_Vehicle_KEY") {
      combined.CRM_Vehicle_KEY = value;
      continue;
    }

    if (!(key in combined)) {
      combined[key] = value;
      continue;
    }

    combined[`VehicleDates_${key}`] = value;
  }

  return combined;
}

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

function extractCollectionName(collection) {
  return collection?.collectionName || collection?.name || collection?.key || "";
}

async function ensureCollection(client, apiOrigin, collectionName) {
  const collections = normalizeCollectionsResponse(await client.get(`${apiOrigin}/insightData/v3/collections`));
  const existing = collections.find(
    (collection) => extractCollectionName(collection).toLowerCase() === collectionName.toLowerCase()
  );

  if (existing) {
    const scope = existing?.collectionScope || existing?.scope || "unknown";
    const type = existing?.collectionType || existing?.type || "unknown";
    console.log(`Collection exists: ${collectionName} [scope=${scope}, type=${type}]`);
    return;
  }

  await client.request({
    method: "POST",
    url: `${apiOrigin}/insightData/v3/collections/${encodeURIComponent(collectionName)}`,
    params: {
      collectionScope: "contact",
      collectionType: "custom"
    }
  });

  console.log(`Collection created: ${collectionName} [scope=contact, type=custom]`);
}

async function upsertContactInsightRecord(client, insightData, apiOrigin, contactIdentifier, collectionName, recordId, data) {
  const v3Endpoint = `${apiOrigin}/insightData/v3/contacts/email/${encodeURIComponent(contactIdentifier)}/${encodeURIComponent(collectionName)}/${encodeURIComponent(recordId)}`;

  try {
    await client.request({
      method: "PUT",
      url: v3Endpoint,
      data
    });
    return;
  } catch (error) {
    const message = String(error.message || "");

    if (!message.includes("(404)")) {
      throw error;
    }
  }

  await insightData.upsertContactRecord({
    contactIdentifier,
    collectionName,
    recordId,
    data
  });
}

async function importVehicleMarketingEventsRecord() {
  const {
    apply,
    contactIdentifier,
    collectionName,
    vehicleSchemaPath,
    vehicleDatesSchemaPath,
    recordId,
    crmVehicleKey
  } = getArgs();

  const env = loadEnv();
  const apiOrigin = new URL(env.baseUrl).origin;

  const client = new DotdigitalClient({
    baseUrl: env.baseUrl,
    username: env.username,
    password: env.password
  });
  const insightData = new InsightDataService(client);

  const vehicleSchemaRows = readSchemaRows(vehicleSchemaPath);
  const vehicleDatesSchemaRows = readSchemaRows(vehicleDatesSchemaPath);
  const vehicleData = buildRecordFromSchema(vehicleSchemaRows, crmVehicleKey);
  const vehicleDatesData = buildRecordFromSchema(vehicleDatesSchemaRows, crmVehicleKey);
  const combinedRecord = combineJoinedRecord(vehicleData, vehicleDatesData);

  console.log(`Contact identifier: ${contactIdentifier}`);
  console.log(`Collection: ${collectionName}`);
  console.log(`Vehicles schema: ${vehicleSchemaPath}`);
  console.log(`VehicleDates schema: ${vehicleDatesSchemaPath}`);
  console.log(`Record ID: ${recordId}`);
  console.log(`Join key (CRM_Vehicle_KEY): ${crmVehicleKey}`);
  console.log(`Joined fields in payload: ${Object.keys(combinedRecord).length}`);

  await ensureCollection(client, apiOrigin, collectionName);

  if (!apply) {
    console.log("Dry run only. Re-run with --apply to upsert the VehicleMarketingEvents record.");
    console.log("Payload preview:");
    console.log(
      JSON.stringify(
        {
          contactIdentifier,
          collectionName,
          recordId,
          data: combinedRecord
        },
        null,
        2
      )
    );
    return;
  }

  await upsertContactInsightRecord(
    client,
    insightData,
    apiOrigin,
    contactIdentifier,
    collectionName,
    recordId,
    combinedRecord
  );

  console.log("VehicleMarketingEvents record upsert completed.");
}

importVehicleMarketingEventsRecord().catch((error) => {
  console.error("Failed to import VehicleMarketingEvents record:", error.message);
  process.exit(1);
});