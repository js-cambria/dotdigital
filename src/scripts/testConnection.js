const { loadEnv } = require("../config/env");
const { DotdigitalClient } = require("../clients/dotdigitalClient");

async function testConnection() {
  const env = loadEnv();

  const client = new DotdigitalClient({
    baseUrl: env.baseUrl,
    username: env.username,
    password: env.password
  });

  try {
    const accountInfo = await client.get("/account-info");
    const accountName = accountInfo?.name || accountInfo?.accountName || "unknown";
    console.log("Connection OK");
    console.log(`Account: ${accountName}`);
    return;
  } catch (error) {
    const message = String(error.message || "");

    if (!message.includes("(404)")) {
      throw error;
    }

    // Fallback check for accounts where /account-info is unavailable.
    const contacts = await client.get("/contacts");
    const count = Array.isArray(contacts)
      ? contacts.length
      : contacts?.items?.length ?? contacts?.records?.length ?? "unknown";

    console.log("Connection OK");
    console.log(`Contacts endpoint reachable. Records returned: ${count}`);
  }
}

testConnection().catch((error) => {
  console.error("Connection FAILED:", error.message);
  process.exit(1);
});
