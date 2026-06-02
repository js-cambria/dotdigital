const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const { loadEnv } = require("../config/env");
const { DotdigitalClient } = require("../clients/dotdigitalClient");

const DEFAULT_SCHEMA_PATH = "data/insight/schemas/dd_Customers_schema.csv";
const DEFAULT_ALIAS_PATH = "data/insight/schemas/contactDataFieldAliases.json";
const DEFAULT_TEST_EMAIL = "jacob.stapleton@cambriaautos.co.uk";
const DEFAULT_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 400;

function mapSqlTypeToDotdigital(sqlType) {
  const type = String(sqlType || "").trim().toLowerCase();

  if (["nvarchar", "varchar", "char", "nchar", "text", "ntext", "uniqueidentifier"].includes(type)) {
    return "String";
  }

  if (["numeric", "decimal", "int", "bigint", "smallint", "tinyint", "float", "real", "money"].includes(type)) {
    return "Numeric";
  }

  if (["date", "datetime", "datetime2", "smalldatetime", "timestamp"].includes(type)) {
    return "Date";
  }

  if (["bit", "boolean"].includes(type)) {
    return "Boolean";
  }

  return null;
}

function readJsonFile(filePath, fallbackValue) {
  if (!fs.existsSync(filePath)) {
    return fallbackValue;
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function getArgs() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const positionalArgs = args.filter((arg) => !arg.startsWith("--"));
  const retryArg = args.find((arg) => arg.startsWith("--retries="));
  const retryDelayArg = args.find((arg) => arg.startsWith("--retry-delay-ms="));
  const emailArg = positionalArgs[0] || DEFAULT_TEST_EMAIL;
  const schemaPathArg = positionalArgs[1] || DEFAULT_SCHEMA_PATH;
  const aliasPathArg = positionalArgs[2] || DEFAULT_ALIAS_PATH;

  const retries = retryArg ? Number(retryArg.split("=")[1]) : DEFAULT_RETRIES;
  const retryDelayMs = retryDelayArg ? Number(retryDelayArg.split("=")[1]) : DEFAULT_RETRY_DELAY_MS;

  return {
    apply,
    email: emailArg,
    schemaPath: path.resolve(schemaPathArg),
    aliasPath: path.resolve(aliasPathArg),
    retries: Number.isFinite(retries) && retries >= 0 ? retries : DEFAULT_RETRIES,
    retryDelayMs:
      Number.isFinite(retryDelayMs) && retryDelayMs >= 0 ? retryDelayMs : DEFAULT_RETRY_DELAY_MS
  };
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getApiStatusCode(error) {
  const match = String(error?.message || "").match(/Dotdigital API error \((\d{3})\)/);

  if (!match) {
    return null;
  }

  return Number(match[1]);
}

function isRetryableStatus(status) {
  if (!status) {
    return false;
  }

  return status === 401 || status === 408 || status === 409 || status === 429 || status >= 500;
}

async function postContactWithRetry(client, payload, retries, retryDelayMs) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await client.post("/contacts", payload);
      return;
    } catch (error) {
      const status = getApiStatusCode(error);
      const canRetry = isRetryableStatus(status) && attempt < retries;

      if (!canRetry) {
        throw error;
      }

      const delayMs = retryDelayMs * (attempt + 1);
      console.log(
        `Retrying contact import after API ${status}. Attempt ${attempt + 2}/${retries + 1} in ${delayMs}ms.`
      );
      await sleep(delayMs);
    }
  }
}

function loadAliases(aliasPath) {
  const aliases = readJsonFile(aliasPath, {});

  if (!aliases || Array.isArray(aliases) || typeof aliases !== "object") {
    throw new Error(`Alias file must contain a JSON object: ${aliasPath}`);
  }

  return aliases;
}

function readSchemaRows(csvPath, aliases) {
  if (!fs.existsSync(csvPath)) {
    throw new Error(`Schema CSV not found: ${csvPath}`);
  }

  const content = fs.readFileSync(csvPath, "utf8");
  const rows = parse(content, {
    columns: false,
    skip_empty_lines: true,
    trim: true
  });

  return rows.map((row, index) => {
    const line = index + 1;
    const [sourceName, sqlType, maxLength, precision, scale] = row;
    const normalizedSourceName = String(sourceName || "").trim();

    if (!normalizedSourceName || !sqlType) {
      throw new Error(`Invalid schema row at line ${line}: expected at least name and SQL type.`);
    }

    const mappedName = String(aliases[normalizedSourceName] || normalizedSourceName).trim();

    return {
      line,
      sourceName: normalizedSourceName,
      name: mappedName,
      sqlType: String(sqlType).trim(),
      maxLength: Number.isFinite(Number(maxLength)) ? Number(maxLength) : null,
      precision: Number.isFinite(Number(precision)) ? Number(precision) : null,
      scale: Number.isFinite(Number(scale)) ? Number(scale) : null,
      dotdigitalType: mapSqlTypeToDotdigital(sqlType)
    };
  });
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function truncateString(value, maxLength) {
  if (!maxLength || value.length <= maxLength) {
    return value;
  }

  return value.slice(0, maxLength);
}

function buildStringValue(field, email) {
  const upperName = field.name.toUpperCase();

  if (upperName === "EMAIL_1") {
    return truncateString(email, field.maxLength);
  }

  if (upperName === "EMAIL_2") {
    const secondary = `alt+${email}`;
    return truncateString(secondary, field.maxLength);
  }

  if (upperName.includes("FORENAME")) {
    return truncateString("Jacob", field.maxLength);
  }

  if (upperName.includes("SURNAME") || upperName.includes("LASTNAME")) {
    return truncateString("Stapleton", field.maxLength);
  }

  if (upperName === "CONTACT_NAME") {
    return truncateString("Jacob Stapleton", field.maxLength);
  }

  if (upperName === "DEAR_NAME") {
    return truncateString("Jacob", field.maxLength);
  }

  if (upperName.includes("POST_CODE") || upperName.includes("POSTCODE")) {
    return truncateString("SW1A1AA", field.maxLength);
  }

  if (upperName.includes("TELEPHONE")) {
    return truncateString("07123456789", field.maxLength);
  }

  if (upperName === "TITLE") {
    return truncateString("Mr", field.maxLength);
  }

  if (upperName.includes("ALLOW_") || upperName.includes("TPS") || upperName === "MPS") {
    return truncateString("Yes", field.maxLength);
  }

  if (upperName.endsWith("_DATE") || upperName === "CREATED_DATE" || upperName === "LAST_AMENDED_DATE") {
    return truncateString(todayIsoDate(), field.maxLength);
  }

  if (field.sqlType.toLowerCase() === "uniqueidentifier" || upperName.endsWith("_KEY") || upperName.endsWith("_UID")) {
    return truncateString("11111111-1111-1111-1111-111111111111", field.maxLength);
  }

  return truncateString(`TEST_${field.name}`, field.maxLength);
}

function buildNumericValue(field) {
  if (field.scale && field.scale > 0) {
    return Number((123.45).toFixed(field.scale));
  }

  return 123;
}

function buildFieldValue(field, email) {
  if (field.dotdigitalType === "String") {
    return buildStringValue(field, email);
  }

  if (field.dotdigitalType === "Numeric") {
    return buildNumericValue(field);
  }

  if (field.dotdigitalType === "Boolean") {
    return true;
  }

  if (field.dotdigitalType === "Date") {
    return todayIsoDate();
  }

  return null;
}

async function importTestContactFromSchema() {
  const { apply, email, schemaPath, aliasPath, retries, retryDelayMs } = getArgs();
  const env = loadEnv();

  const client = new DotdigitalClient({
    baseUrl: env.baseUrl,
    username: env.username,
    password: env.password
  });

  const aliases = loadAliases(aliasPath);
  const schemaRows = readSchemaRows(schemaPath, aliases);
  const unsupportedRows = schemaRows.filter((row) => !row.dotdigitalType);

  if (unsupportedRows.length > 0) {
    const summary = unsupportedRows
      .slice(0, 5)
      .map((row) => `${row.name}:${row.sqlType}`)
      .join(", ");
    throw new Error(`Unsupported SQL types in schema. Sample: ${summary}`);
  }

  const existingFields = await client.get("/data-fields");
  const existingNames = new Set(existingFields.map((field) => String(field.name || "").toUpperCase()));
  const missingDotdigitalFields = schemaRows.filter((row) => !existingNames.has(row.name.toUpperCase()));

  if (missingDotdigitalFields.length > 0) {
    const sample = missingDotdigitalFields
      .slice(0, 10)
      .map((row) => row.name)
      .join(", ");
    throw new Error(
      `Schema contains fields that do not yet exist in Dotdigital (${missingDotdigitalFields.length}). Sample: ${sample}`
    );
  }

  const dataFields = [];

  for (const row of schemaRows) {
    dataFields.push({
      key: row.name.toUpperCase(),
      value: buildFieldValue(row, email)
    });
  }

  const payload = {
    email,
    firstName: "Jacob",
    lastName: "Stapleton",
    dataFields
  };

  console.log(`Schema file: ${schemaPath}`);
  console.log(`Alias file: ${aliasPath}`);
  console.log(`Target email: ${email}`);
  console.log(`Fields in payload: ${dataFields.length}`);
  console.log(`Import retries: ${retries}`);
  console.log(`Retry delay (ms): ${retryDelayMs}`);

  if (!apply) {
    console.log("Dry run only. Re-run with --apply to create/update the test contact.");
    console.log("Payload preview:");
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  await postContactWithRetry(client, payload, retries, retryDelayMs);
  console.log("Test contact create/update completed.");
}

importTestContactFromSchema().catch((error) => {
  console.error("Failed to import test contact from schema:", error.message);
  process.exit(1);
});