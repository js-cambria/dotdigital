const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const { loadEnv } = require("../config/env");
const { DotdigitalClient } = require("../clients/dotdigitalClient");

const DOTDIGITAL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,20}$/;
const DEFAULT_SCHEMA_PATH = "data/insight/schemas/dd_Customers_schema.csv";
const DEFAULT_ALIAS_PATH = "data/insight/schemas/contactDataFieldAliases.json";
const DEFAULT_TRACKER_PATH = "data/insight/datafields/contactDataFields.sync-log.json";
const MIN_SIMILARITY_SCORE = 0.7;
const MAX_SIMILAR_MATCHES = 3;
const DEFAULT_CREATE_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 400;

function getArgs() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const positionalArgs = args.filter((arg) => !arg.startsWith("--"));
  const retryArg = args.find((arg) => arg.startsWith("--retries="));
  const retryDelayArg = args.find((arg) => arg.startsWith("--retry-delay-ms="));
  const csvPathArg = positionalArgs[0] || DEFAULT_SCHEMA_PATH;
  const aliasPathArg = positionalArgs[1] || DEFAULT_ALIAS_PATH;
  const trackerPathArg = positionalArgs[2] || DEFAULT_TRACKER_PATH;

  const retries = retryArg ? Number(retryArg.split("=")[1]) : DEFAULT_CREATE_RETRIES;
  const retryDelayMs = retryDelayArg ? Number(retryDelayArg.split("=")[1]) : DEFAULT_RETRY_DELAY_MS;

  return {
    apply,
    csvPath: path.resolve(csvPathArg),
    aliasPath: path.resolve(aliasPathArg),
    trackerPath: path.resolve(trackerPathArg),
    retries: Number.isFinite(retries) && retries >= 0 ? retries : DEFAULT_CREATE_RETRIES,
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

async function createFieldWithRetry(client, row, retries, retryDelayMs) {
  let attempt = 0;
  let lastError = null;

  while (attempt <= retries) {
    try {
      await client.post("/data-fields", {
        name: row.name,
        type: row.dotdigitalType,
        visibility: "Private"
      });
      return;
    } catch (error) {
      lastError = error;
      const status = getApiStatusCode(error);
      const canRetry = isRetryableStatus(status) && attempt < retries;

      if (!canRetry) {
        throw error;
      }

      const delayMs = retryDelayMs * (attempt + 1);
      console.log(
        `Retrying create for ${row.name} after API ${status}. Attempt ${attempt + 2}/${retries + 1} in ${delayMs}ms.`
      );
      await sleep(delayMs);
    }

    attempt += 1;
  }

  throw lastError;
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

function normalizeForSimilarity(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function getBigrams(value) {
  if (value.length < 2) {
    return [];
  }

  const grams = [];

  for (let i = 0; i < value.length - 1; i += 1) {
    grams.push(value.slice(i, i + 2));
  }

  return grams;
}

function diceCoefficient(left, right) {
  if (!left || !right) {
    return 0;
  }

  if (left === right) {
    return 1;
  }

  const leftBigrams = getBigrams(left);
  const rightBigrams = getBigrams(right);

  if (leftBigrams.length === 0 || rightBigrams.length === 0) {
    return 0;
  }

  const rightCounts = new Map();
  for (const gram of rightBigrams) {
    rightCounts.set(gram, (rightCounts.get(gram) || 0) + 1);
  }

  let overlap = 0;
  for (const gram of leftBigrams) {
    const count = rightCounts.get(gram) || 0;
    if (count > 0) {
      overlap += 1;
      rightCounts.set(gram, count - 1);
    }
  }

  return (2 * overlap) / (leftBigrams.length + rightBigrams.length);
}

function calculateNameSimilarity(targetName, existingName) {
  const target = normalizeForSimilarity(targetName);
  const existing = normalizeForSimilarity(existingName);

  if (!target || !existing) {
    return 0;
  }

  if (target === existing) {
    return 1;
  }

  if (target.includes(existing) || existing.includes(target)) {
    const shorter = Math.min(target.length, existing.length);
    const longer = Math.max(target.length, existing.length);
    return Math.max(0.7, shorter / longer);
  }

  const sharedPrefixLength = target
    .split("")
    .findIndex((char, index) => char !== existing[index]);
  const prefixLength = sharedPrefixLength === -1 ? Math.min(target.length, existing.length) : sharedPrefixLength;
  const prefixBoost = Math.min(prefixLength, 4) * 0.03;

  return Math.min(1, diceCoefficient(target, existing) + prefixBoost);
}

function findSimilarExistingFields(targetName, existingFields) {
  const candidates = [];

  for (const field of existingFields) {
    const score = calculateNameSimilarity(targetName, field.name);

    if (score < MIN_SIMILARITY_SCORE) {
      continue;
    }

    candidates.push({
      name: field.name,
      type: field.type,
      visibility: field.visibility,
      score
    });
  }

  return candidates
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_SIMILAR_MATCHES);
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
  const { apply, csvPath, aliasPath, trackerPath, retries, retryDelayMs } = getArgs();
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
        similarMatchCount: 0,
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
    similarExistingFields: [],
    createdFields: []
  };

  const similarRows = missingRows
    .map((row) => ({
      row,
      matches: findSimilarExistingFields(row.name, existingFields)
    }))
    .filter((entry) => entry.matches.length > 0);

  runRecord.summary.similarMatchCount = similarRows.length;
  runRecord.similarExistingFields = similarRows.map((entry) =>
    toTrackerField(entry.row, {
      similarMatches: entry.matches.map((match) => ({
        name: match.name,
        type: match.type,
        visibility: match.visibility,
        score: Number(match.score.toFixed(2))
      }))
    })
  );

  console.log(`Schema file: ${csvPath}`);
  console.log(`Alias file: ${aliasPath}`);
  console.log(`Tracker file: ${trackerPath}`);
  console.log(`Create retries per field: ${retries}`);
  console.log(`Retry delay (ms): ${retryDelayMs}`);
  console.log(`Existing Dotdigital data fields: ${existingFields.length}`);
  console.log(`Aliased fields: ${aliasRows.length}`);
  console.log(`Matching fields: ${matchedRows.length}`);
  console.log(`Missing fields: ${missingRows.length}`);
  console.log(`Missing fields with similar existing IDs: ${similarRows.length}`);
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

  if (similarRows.length > 0) {
    console.log("Potentially similar existing Dotdigital field IDs:");
    for (const entry of similarRows) {
      console.log(`- ${entry.row.name} (from ${entry.row.sourceName}):`);
      for (const match of entry.matches) {
        console.log(
          `  -> ${match.name} | type=${match.type} | visibility=${match.visibility} | similarity=${match.score.toFixed(2)}`
        );
      }
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
      await createFieldWithRetry(client, row, retries, retryDelayMs);

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
    runRecord.summary.remainingCount = missingRows.length - runRecord.summary.createdCount;
    appendTrackerRun(trackerPath, runRecord);
    console.log(
      `Partial completion: created ${runRecord.summary.createdCount}/${missingRows.length}. Re-run with --apply to resume missing fields.`
    );
    throw error;
  }

  appendTrackerRun(trackerPath, runRecord);
}

syncContactDataFields().catch((error) => {
  console.error("Failed to sync contact data fields:", error.message);
  process.exit(1);
});
