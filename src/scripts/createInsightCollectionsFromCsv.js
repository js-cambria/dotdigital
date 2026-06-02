const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const { loadEnv } = require("../config/env");
const { DotdigitalClient } = require("../clients/dotdigitalClient");

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

function parseOptions(args) {
  const positional = [];
  const options = {};

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    if (arg.includes("=")) {
      const [key, value] = arg.slice(2).split("=");
      options[key] = value;
      continue;
    }

    const key = arg.slice(2);
    const next = args[i + 1];

    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }

    options[key] = next;
    i += 1;
  }

  return {
    positional,
    options
  };
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

function normalizeScope(scope) {
  return String(scope || "").trim().toLowerCase();
}

function extractCollectionName(collection) {
  return collection?.collectionName || collection?.name || collection?.key || "";
}

function extractSchemaFields(schemaResponse) {
  const result = [];
  const rawSchema = schemaResponse?.schema;

  if (Array.isArray(rawSchema)) {
    for (const entry of rawSchema) {
      if (typeof entry === "string") {
        result.push({
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

        result.push({
          name,
          type: String(entry.type || entry.dataType || "").toLowerCase() || null
        });
      }
    }
  }

  if (rawSchema && typeof rawSchema === "object" && rawSchema.properties && typeof rawSchema.properties === "object") {
    for (const [name, definition] of Object.entries(rawSchema.properties)) {
      result.push({
        name,
        type: String(definition?.type || "").toLowerCase() || null
      });
    }
  }

  return result;
}

function readCollectionFieldSchema(schemaPath) {
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`Collection schema CSV not found: ${schemaPath}`);
  }

  const content = fs.readFileSync(schemaPath, "utf8");
  const rows = parse(content, {
    columns: false,
    skip_empty_lines: true,
    trim: true
  });

  return rows.map((row, index) => {
    const line = index + 1;
    const [fieldName, sqlType] = row;

    if (!fieldName || !sqlType) {
      throw new Error(`Invalid collection schema row at line ${line}: fieldName and SQL type are required.`);
    }

    const schemaType = mapSqlTypeToSchemaType(sqlType);

    return {
      line,
      fieldName: String(fieldName).trim(),
      sqlType: String(sqlType).trim(),
      schemaType
    };
  });
}

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
  const args = process.argv.slice(2);
  const { positional, options } = parseOptions(args);
  const firstPositional = positional[0];
  const isCsvMode = !firstPositional || firstPositional.toLowerCase().endsWith(".csv");

  const client = new DotdigitalClient({
    baseUrl: env.baseUrl,
    username: env.username,
    password: env.password
  });

  if (isCsvMode) {
    const schemaPathArg = firstPositional || "data/insight/schemas/collections.csv";
    const schemaPath = path.resolve(schemaPathArg);
    const rows = readSchemaCsv(schemaPath);

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

    return;
  }

  const collectionName = firstPositional;
  const collectionScope = normalizeScope(options.scope || "contact");
  const collectionType = String(options.type || "custom").trim();
  const schemaPathArg =
    options.schema || `data/insight/schemas/insight/dd_${collectionName}_schema.csv`;
  const schemaPath = path.resolve(schemaPathArg);

  if (!collectionName) {
    throw new Error("Collection name is required for single collection mode.");
  }

  if (!["account", "contact"].includes(collectionScope)) {
    throw new Error('Invalid --scope value. Use "account" or "contact".');
  }

  const expectedFields = readCollectionFieldSchema(schemaPath);
  const unsupportedTypeFields = expectedFields.filter((field) => !field.schemaType);

  if (unsupportedTypeFields.length > 0) {
    const sample = unsupportedTypeFields
      .slice(0, 5)
      .map((field) => `${field.fieldName}:${field.sqlType}`)
      .join(", ");
    throw new Error(`Unsupported SQL types found in schema: ${sample}`);
  }

  const collections = normalizeCollectionsResponse(await client.get(`${apiOrigin}/insightData/v3/collections`));
  const existingCollection = collections.find(
    (collection) => extractCollectionName(collection).toLowerCase() === collectionName.toLowerCase()
  );

  if (existingCollection) {
    const existingScope = normalizeScope(existingCollection.collectionScope || existingCollection.scope);
    const existingType = String(existingCollection.collectionType || existingCollection.type || "").toLowerCase();
    console.log(
      `Collection exists: ${collectionName} [scope=${existingScope || "unknown"}, type=${existingType || "unknown"}]`
    );
  } else {
    const createEndpoint = `${apiOrigin}/insightData/v3/collections/${encodeURIComponent(collectionName)}`;
    await client.request({
      method: "POST",
      url: createEndpoint,
      params: {
        collectionScope,
        collectionType
      }
    });
    console.log(`Collection created: ${collectionName} [scope=${collectionScope}, type=${collectionType}]`);
  }

  const schemaEndpoint = `${apiOrigin}/insightData/v3/collections/${encodeURIComponent(collectionName)}/schema`;
  const collectionSchema = await client.get(schemaEndpoint);
  const existingSchemaFields = extractSchemaFields(collectionSchema);
  const existingByName = new Map(
    existingSchemaFields.map((field) => [String(field.name || "").toLowerCase(), field])
  );

  const missingFields = [];
  const typeMismatchFields = [];

  for (const field of expectedFields) {
    const existingField = existingByName.get(field.fieldName.toLowerCase());

    if (!existingField) {
      missingFields.push(field);
      continue;
    }

    if (existingField.type && existingField.type !== field.schemaType) {
      typeMismatchFields.push({
        fieldName: field.fieldName,
        expectedType: field.schemaType,
        existingType: existingField.type
      });
    }
  }

  console.log(`Schema file: ${schemaPath}`);
  console.log(`Expected schema fields: ${expectedFields.length}`);
  console.log(`Existing Dotdigital schema fields: ${existingSchemaFields.length}`);
  console.log(`Missing fields in Dotdigital schema: ${missingFields.length}`);
  console.log(`Type mismatches: ${typeMismatchFields.length}`);

  if (missingFields.length > 0) {
    console.log("Missing fields:");
    for (const field of missingFields) {
      console.log(`- ${field.fieldName} => ${field.schemaType} (sqlType=${field.sqlType})`);
    }
  }

  if (typeMismatchFields.length > 0) {
    console.log("Type mismatches:");
    for (const mismatch of typeMismatchFields) {
      console.log(
        `- ${mismatch.fieldName}: expected=${mismatch.expectedType}, existing=${mismatch.existingType}`
      );
    }
  }

  if (missingFields.length === 0 && typeMismatchFields.length === 0) {
    console.log("Schema is aligned with Dotdigital.");
    return;
  }

  console.log(
    "Dotdigital Insight Data API does not provide a schema write endpoint. Add/update schema fields by importing records that contain the desired fields."
  );
}

createCollections().catch((error) => {
  console.error("Failed to create collections from CSV:", error.message);
  process.exit(1);
});
