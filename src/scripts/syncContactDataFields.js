const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const { loadEnv } = require("../config/env");
const { DotdigitalClient } = require("../clients/dotdigitalClient");

const DOTDIGITAL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,20}$/;
const DEFAULT_SCHEMA_PATH = "data/insight/schemas/dd_Customers_schema.csv";
const DEFAULT_ALIAS_PATH = "data/insight/schemas/contactDataFieldAliases.json";
const DEFAULT_TRACKER_PATH = "data/insight/datafields/contactDataFields.sync-log.json";

function getArgs() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const positionalArgs = args.filter((arg) => !arg.startsWith("--"));
  const csvPathArg = positionalArgs[0] || DEFAULT_SCHEMA_PATH;
  const aliasPathArg = positionalArgs[1] || DEFAULT_ALIAS_PATH;
  const trackerPathArg = positionalArgs[2] || DEFAULT_TRACKER_PATH;

  return {
    apply,
    csvPath: path.resolve(csvPathArg),
    aliasPath: path.resolve(aliasPathArg),
    trackerPath: path.resolve(trackerPathArg)
  };
}

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

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
    const [sourceName, sqlType, maxLength, precision, scale, , nullable] = row;
    const normalizedSourceName = String(sourceName || "").trim();
    const mappedName = String(aliases[normalizedSourceName] || normalizedSourceName).trim();
    const dotdigitalType = mapSqlTypeToDotdigital(sqlType);

    if (!normalizedSourceName || !sqlType) {
      throw new Error(`Invalid schema row at line ${line}: expected at least name and SQL type.`);
    }

    return {
      line,
      sourceName: normalizedSourceName,
      name: mappedName,
      aliasApplied: mappedName !== normalizedSourceName,
      sqlType: String(sqlType).trim(),
      maxLength: maxLength || null,
      precision: precision || null,
      scale: scale || null,
      nullable: String(nullable || "").trim().toUpperCase() === "YES",
      dotdigitalType,
      isValidName: DOTDIGITAL_NAME_PATTERN.test(mappedName)
    };
  });
}

function indexExistingFields(fields) {
  const map = new Map();

  for (const field of fields) {
    map.set(String(field.name || "").toUpperCase(), field);
  }

  return map;
}

function toTrackerField(row, extras = {}) {
  return {
    line: row.line,
    sourceName: row.sourceName,
    dotdigitalName: row.name,
    aliasApplied: row.aliasApplied,
    sqlType: row.sqlType,
    dotdigitalType: row.dotdigitalType,
    ...extras
  };
}

function appendTrackerRun(trackerPath, runRecord) {
  const tracker = readJsonFile(trackerPath, {
    runs: []
  });

  tracker.runs.push(runRecord);
  writeJsonFile(trackerPath, tracker);
}

async function syncContactDataFields() {
  const { apply, csvPath, aliasPath, trackerPath } = getArgs();
  const env = loadEnv();

  const client = new DotdigitalClient({
    baseUrl: env.baseUrl,
    username: env.username,
    password: env.password
  });

  const aliases = loadAliases(aliasPath);
  const schemaRows = readSchemaRows(csvPath, aliases);
  const existingFields = await client.get("/data-fields");
  const existingByName = indexExistingFields(existingFields);

  const invalidRows = [];
  const unsupportedTypeRows = [];
  const missingRows = [];
  const matchedRows = [];
  const mismatchRows = [];
  const aliasRows = schemaRows.filter((row) => row.aliasApplied);

  for (const row of schemaRows) {
    if (!row.isValidName) {
      invalidRows.push(row);
      continue;
    }

    if (!row.dotdigitalType) {
      unsupportedTypeRows.push(row);
      continue;
    }

    const existing = existingByName.get(row.name.toUpperCase());

    if (!existing) {
      missingRows.push(row);
      continue;
    }

    if (existing.type !== row.dotdigitalType) {
      mismatchRows.push({
        ...row,
        existingType: existing.type,
        existingVisibility: existing.visibility
      });
      continue;
    }

    matchedRows.push({
      ...row,
      existingVisibility: existing.visibility
    });
  }

  const runRecord = {
    timestamp: new Date().toISOString(),
    mode: apply ? "apply" : "dry-run",
    schemaPath: csvPath,
    aliasPath,
    summary: {
      existingDotdigitalFields: existingFields.length,
      aliasCount: aliasRows.length,
      matchingCount: matchedRows.length,
      missingCount: missingRows.length,
      mismatchCount: mismatchRows.length,
      invalidCount: invalidRows.length,
      unsupportedTypeCount: unsupportedTypeRows.length,
      createdCount: 0
    },
    aliases: aliasRows.map((row) => ({
      sourceName: row.sourceName,
      dotdigitalName: row.name
    })),
    missingFields: missingRows.map((row) => toTrackerField(row)),
    matchingFields: matchedRows.map((row) =>
      toTrackerField(row, {
        visibility: row.existingVisibility
      })
    ),
    mismatches: mismatchRows.map((row) =>
      toTrackerField(row, {
        existingType: row.existingType,
        existingVisibility: row.existingVisibility
      })
    ),
    invalidFields: invalidRows.map((row) =>
      toTrackerField(row, {
        reason: `Dotdigital names must match ${DOTDIGITAL_NAME_PATTERN}`
      })
    ),
    unsupportedTypes: unsupportedTypeRows.map((row) =>
      toTrackerField(row, {
        reason: `Unsupported SQL type ${row.sqlType}`
      })
    ),
    createdFields: []
  };

  console.log(`Schema file: ${csvPath}`);
  console.log(`Alias file: ${aliasPath}`);
  console.log(`Tracker file: ${trackerPath}`);
  console.log(`Existing Dotdigital data fields: ${existingFields.length}`);
  console.log(`Aliased fields: ${aliasRows.length}`);
  console.log(`Matching fields: ${matchedRows.length}`);
  console.log(`Missing fields: ${missingRows.length}`);
  console.log(`Type mismatches: ${mismatchRows.length}`);
  console.log(`Invalid names: ${invalidRows.length}`);
  console.log(`Unsupported SQL types: ${unsupportedTypeRows.length}`);

  if (aliasRows.length > 0) {
    console.log("Applied aliases:");
    for (const row of aliasRows) {
      console.log(`- ${row.sourceName} => ${row.name}`);
    }
  }

  if (missingRows.length > 0) {
    console.log("Missing fields:");
    for (const row of missingRows) {
      const aliasSuffix = row.aliasApplied ? ` [from ${row.sourceName}]` : "";
      console.log(`- ${row.name} => ${row.dotdigitalType}${aliasSuffix}`);
    }
  }

  if (mismatchRows.length > 0) {
    console.log("Type mismatches:");
    for (const row of mismatchRows) {
      console.log(`- ${row.name}: schema=${row.dotdigitalType}, dotdigital=${row.existingType}`);
    }
  }

  if (invalidRows.length > 0) {
    console.log("Invalid Dotdigital field names:");
    for (const row of invalidRows) {
      console.log(`- ${row.name} (line ${row.line}) must match ${DOTDIGITAL_NAME_PATTERN}`);
    }
  }

  if (unsupportedTypeRows.length > 0) {
    console.log("Unsupported SQL types:");
    for (const row of unsupportedTypeRows) {
      console.log(`- ${row.sourceName} (line ${row.line}) sqlType=${row.sqlType}`);
    }
  }

  if (!apply) {
    appendTrackerRun(trackerPath, runRecord);
    console.log("Dry run only. Re-run with --apply to create missing fields.");
    return;
  }

  if (missingRows.length === 0) {
    appendTrackerRun(trackerPath, runRecord);
    console.log("No missing fields to create.");
    return;
  }

  try {
    for (const row of missingRows) {
      await client.post("/data-fields", {
        name: row.name,
        type: row.dotdigitalType,
        visibility: "Private"
      });

      runRecord.createdFields.push(
        toTrackerField(row, {
          visibility: "Private"
        })
      );
      runRecord.summary.createdCount += 1;

      console.log(`Created data field: ${row.name} (${row.dotdigitalType})`);
    }
  } catch (error) {
    runRecord.error = error.message;
    appendTrackerRun(trackerPath, runRecord);
    throw error;
  }

  appendTrackerRun(trackerPath, runRecord);
}

syncContactDataFields().catch((error) => {
  console.error("Failed to sync contact data fields:", error.message);
  process.exit(1);
});
