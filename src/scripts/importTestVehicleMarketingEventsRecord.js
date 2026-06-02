const { spawnSync } = require("child_process");
const path = require("path");

const DEFAULT_CONTACT_IDENTIFIER = "jacob.stapleton@cambriaautos.co.uk";
const DEFAULT_COLLECTION_NAME = "VehicleMarketingEvents";
const DEFAULT_VEHICLE_SCHEMA_PATH = "data/insight/schemas/insight/dd_Vehicles_schema.csv";
const DEFAULT_VEHICLE_DATES_SCHEMA_PATH = "data/insight/schemas/insight/dd_VehicleDates_schema.csv";
const DEFAULT_RECORD_ID = "VEHICLE_MARKETING_EVENT_TEST_001";
const DEFAULT_CRM_VEHICLE_KEY = "11111111-1111-1111-1111-111111111111";

function run() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");

  const scriptPath = path.resolve(__dirname, "importVehicleMarketingEventsRecord.js");
  const cmdArgs = [
    scriptPath,
    DEFAULT_CONTACT_IDENTIFIER,
    DEFAULT_COLLECTION_NAME,
    DEFAULT_VEHICLE_SCHEMA_PATH,
    DEFAULT_VEHICLE_DATES_SCHEMA_PATH,
    DEFAULT_RECORD_ID,
    DEFAULT_CRM_VEHICLE_KEY
  ];

  if (apply) {
    cmdArgs.push("--apply");
  }

  const result = spawnSync("node", cmdArgs, {
    stdio: "inherit"
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

run();