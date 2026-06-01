const { loadEnv } = require("./config/env");
const { DotdigitalClient } = require("./clients/dotdigitalClient");
const { ContactService } = require("./services/contactService");
const { InsightDataService } = require("./services/insightDataService");
const { InsightBuilderService } = require("./services/insightBuilderService");

async function run() {
  const env = loadEnv();

  const client = new DotdigitalClient({
    baseUrl: env.baseUrl,
    username: env.username,
    password: env.password
  });

  const contacts = new ContactService(client);
  const insightData = new InsightDataService(client);
  const insightBuilder = new InsightBuilderService();

  const sampleEmail = "customer@example.com";
  const sampleOrder = {
    id: "order-10001",
    orderTotal: 129.99,
    orderSubtotal: 119.99,
    currency: "USD",
    purchaseDate: new Date().toISOString(),
    products: [
      {
        name: "Trail Backpack",
        sku: "BP-TRAIL-001",
        qty: 1,
        price: 119.99
      }
    ]
  };

  const orderRecord = insightBuilder.buildOrderRecord(sampleOrder);
  const recordId = insightBuilder.buildRecordKey("order", sampleOrder.id);

  if (env.dryRun) {
    console.log("Dry run enabled. No API calls were made.");
    console.log("Prepared contact upsert and insight data payload:");
    console.log(
      JSON.stringify(
        {
          contact: {
            identifier: sampleEmail,
            payload: {
              email: sampleEmail,
              firstName: "Sample",
              lastName: "Customer"
            }
          },
          insight: {
            collectionName: "orders",
            recordId,
            record: orderRecord
          }
        },
        null,
        2
      )
    );
    return;
  }

  await contacts.upsertContactByIdentifier(sampleEmail, {
    email: sampleEmail,
    firstName: "Sample",
    lastName: "Customer"
  });

  await insightData.upsertContactRecord({
    contactIdentifier: sampleEmail,
    collectionName: "orders",
    recordId,
    data: orderRecord
  });

  console.log("Contact and insight data upsert completed.");
}

run().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
