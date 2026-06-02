const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const { loadEnv } = require("../config/env");
const { DotdigitalClient } = require("../clients/dotdigitalClient");
const { InsightDataService } = require("../services/insightDataService");

const DEFAULT_COLLECTION_NAME = "VehicleDates";
const DEFAULT_COLLECTION_SCOPE = "contact";
const DEFAULT_COLLECTION_TYPE = "custom";
const DEFAULT_SCHEMA_PATH = "data/insight/schemas/insight/dd_VehicleDates_schema.csv";
const DEFAULT_CONTACT_IDENTIFIER = "jacob.stapleton@cambriaautos.co.uk";
const DEFAULT_RECORD_ID = "VEHICLEDATES_SCHEMA_SYNC_001";

function getArgs() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const positionalArgs = args.filter((arg) => !arg.startsWith("--"));

  return {
    apply,
    collectionName: positionalArgs[0] || DEFAULT_COLLECTION_NAME,
    schemaPath: path.resolve(positionalArgs[1] || DEFAULT_SCHEMA_PATH),
    contactIdentifier: positionalArgs[2] || DEFAULT_CONTACT_IDENTIFIER,
    recordId: positionalArgs[3] || DEFAULT_RECORD_ID
  };
}

function mapSqlTypeToSchemaType(sqlType) {
  const type = String(sqlType || "").trim().toLowerCase();

  if (["nvarchar", "varchar", "char", "nchar", "text", "ntext", "uniqueidentifier"].includes(type)) {
    return "string";
  }

  if (["numeric", "decimal", "int", "bigint", "smallint", "tinyint", "float", "real", "money"].includes(type)) {
    return "number";
  }

  if (["date", "datetime", "datetime2", "smalldatetime", "timestamp"].includes(type)) {
    return "string";
  }

  if (["bit", "boolean"].includes(type)) {
    return "boolean";
  }

  return null;
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
      sqlType: String(sqlType).trim(),
      maxLength: Number.isFinite(Number(maxLength)) ? Number(maxLength) : null,
      precision: Number.isFinite(Number(precision)) ? Number(precision) : null,
      scale: Number.isFinite(Number(scale)) ? Number(scale) : null,
      schemaType: mapSqlTypeToSchemaType(sqlType)
    };
  });
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

function extractSchemaFields(schemaResponse) {
  const fields = [];
  const rawSchema = schemaResponse?.schema;

  if (Array.isArray(rawSchema)) {
    for (const entry of rawSchema) {
      if (typeof entry === "string") {
        fields.push({
          name: entry,
          type: null
        });
        continue;
      }

      if (entry && typeof entry === "object") {
        const name = entry.name || entry.fieldName || entry.title || entry.id || null;

        if (!name) {
          continue;
        }

        fields.push({
          name,
          type: String(entry.type || entry.dataType || "").toLowerCase() || null
        });
      }
    }
  }

  if (rawSchema && typeof rawSchema === "object" && rawSchema.properties && typeof rawSchema.properties === "object") {
    for (const [name, definition] of Object.entries(rawSchema.properties)) {
      fields.push({
        name,
        type: String(definition?.type || "").toLowerCase() || null
      });
    }
  }

  return fields;
}

function compareSchema(expectedRows, currentFields) {
  const currentByName = new Map(
    currentFields.map((field) => [String(field.name || "").toLowerCase(), field])
  );

  const missingFields = [];
  const typeMismatches = [];

  for (const row of expectedRows) {
    const existing = currentByName.get(row.fieldName.toLowerCase());

    if (!existing) {
      missingFields.push(row);
      continue;
    }

    if (existing.type && row.schemaType && existing.type !== row.schemaType) {
      typeMismatches.push({
        fieldName: row.fieldName,
        expectedType: row.schemaType,
        existingType: existing.type
      });
    }
  }

  return {
    missingFields,
    typeMismatches
  };
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

function buildSeedValue(row) {
  const sqlType = row.sqlType.toLowerCase();
  const upperName = row.fieldName.toUpperCase();

  if (["numeric", "decimal", "int", "bigint", "smallint", "tinyint", "float", "real", "money"].includes(sqlType)) {
    if (row.scale && row.scale > 0) {
      return Number((123.45).toFixed(row.scale));
    }

    return 123;
  }

  if (["bit", "boolean"].includes(sqlType)) {
    return true;
  }

  if (["date", "datetime", "datetime2", "smalldatetime", "timestamp"].includes(sqlType)) {
    return todayIsoDate();
  }

  if (upperName.endsWith("_DATE") || upperName === "EVENT_DATE") {
    return truncateString(todayIsoDate(), row.maxLength);
  }

  if (upperName === "EVENT_TYPE") {
    return truncateString("MOT", row.maxLength);
  }

  if (upperName.includes("ALLOW_") || upperName.includes("HAS_")) {
    return truncateString("Yes", row.maxLength);
  }

  if (upperName.endsWith("_KEY") || upperName.endsWith("_UID")) {
    return truncateString("11111111-1111-1111-1111-111111111111", row.maxLength);
  }

  if (upperName === "DESCRIPTION") {
    return truncateString("Schema sync seed record", row.maxLength);
  }

  return truncateString(`TEST_${row.fieldName}`, row.maxLength);
}

function buildSeedRecord(expectedRows) {
  const data = {};

  for (const row of expectedRows) {
    data[row.fieldName] = buildSeedValue(row);
  }

  return data;
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
      collectionScope: DEFAULT_COLLECTION_SCOPE,
      collectionType: DEFAULT_COLLECTION_TYPE
    }
  });

  console.log(
    `Collection created: ${collectionName} [scope=${DEFAULT_COLLECTION_SCOPE}, type=${DEFAULT_COLLECTION_TYPE}]`
  );
}

async function fetchCollectionSchema(client, apiOrigin, collectionName) {
  const schemaEndpoint = `${apiOrigin}/insightData/v3/collections/${encodeURIComponent(collectionName)}/schema`;
  const schemaResponse = await client.get(schemaEndpoint);
  return extractSchemaFields(schemaResponse);
}

async function upsertSeedRecord(client, insightData, apiOrigin, contactIdentifier, collectionName, recordId, data) {
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

async function syncVehicleDatesSchema() {
  const { apply, collectionName, schemaPath, contactIdentifier, recordId } = getArgs();
  const env = loadEnv();
  const apiOrigin = new URL(env.baseUrl).origin;

  const client = new DotdigitalClient({
    baseUrl: env.baseUrl,
    username: env.username,
    password: env.password
  });
  const insightData = new InsightDataService(client);

  const expectedRows = readSchemaRows(schemaPath);
  const unsupportedRows = expectedRows.filter((row) => !row.schemaType);

  if (unsupportedRows.length > 0) {
    const sample = unsupportedRows
      .slice(0, 5)
      .map((row) => `${row.fieldName}:${row.sqlType}`)
      .join(", ");
    throw new Error(`Unsupported SQL types found in schema. Sample: ${sample}`);
  }

  console.log(`Collection: ${collectionName}`);
  console.log(`Schema file: ${schemaPath}`);
  console.log(`Contact identifier: ${contactIdentifier}`);
  console.log(`Record ID: ${recordId}`);
  console.log(`Expected schema fields: ${expectedRows.length}`);

  await ensureCollection(client, apiOrigin, collectionName);

  const currentFieldsBefore = await fetchCollectionSchema(client, apiOrigin, collectionName);
  const beforeDiff = compareSchema(expectedRows, currentFieldsBefore);

  console.log(`Current schema fields: ${currentFieldsBefore.length}`);
  console.log(`Missing fields: ${beforeDiff.missingFields.length}`);
  console.log(`Type mismatches: ${beforeDiff.typeMismatches.length}`);

  if (beforeDiff.missingFields.length > 0) {
    console.log("Missing fields:");
    for (const row of beforeDiff.missingFields) {
      console.log(`- ${row.fieldName} => ${row.schemaType} (sqlType=${row.sqlType})`);
    }
  }

  if (beforeDiff.typeMismatches.length > 0) {
    console.log("Type mismatches:");
    for (const mismatch of beforeDiff.typeMismatches) {
      console.log(
        `- ${mismatch.fieldName}: expected=${mismatch.expectedType}, existing=${mismatch.existingType}`
      );
    }
  }

  if (!apply) {
    console.log("Dry run only. Re-run with --apply to seed a record and materialize missing schema fields.");
    return;
  }

  const seedRecordData = buildSeedRecord(expectedRows);
  await upsertSeedRecord(client, insightData, apiOrigin, contactIdentifier, collectionName, recordId, seedRecordData);
  console.log("Seed record upsert completed.");

  const currentFieldsAfter = await fetchCollectionSchema(client, apiOrigin, collectionName);
  const afterDiff = compareSchema(expectedRows, currentFieldsAfter);

  console.log(`Schema fields after seed upsert: ${currentFieldsAfter.length}`);
  console.log(`Remaining missing fields: ${afterDiff.missingFields.length}`);
  console.log(`Remaining type mismatches: ${afterDiff.typeMismatches.length}`);

  if (afterDiff.missingFields.length === 0 && afterDiff.typeMismatches.length === 0) {
    console.log("VehicleDates schema is aligned.");
  }
}

syncVehicleDatesSchema().catch((error) => {
  console.error("Failed to sync VehicleDates schema:", error.message);
  process.exit(1);
});