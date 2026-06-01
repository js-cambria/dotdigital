const dotenv = require("dotenv");

dotenv.config();

function getRequiredEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function loadEnv() {
  return {
    baseUrl: process.env.DOTDIGITAL_BASE_URL || "https://r1-api.dotdigital.com/v2",
    username: getRequiredEnv("DOTDIGITAL_USERNAME"),
    password: getRequiredEnv("DOTDIGITAL_PASSWORD"),
    dryRun: process.env.DOTDIGITAL_DRY_RUN === "true"
  };
}

module.exports = {
  loadEnv
};
