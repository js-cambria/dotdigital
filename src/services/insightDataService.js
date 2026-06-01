class InsightDataService {
  constructor(client) {
    this.client = client;
  }

  async listCollections() {
    return this.client.get("/insightdata");
  }

  async createCollection({ name, scope, type }) {
    return this.client.post("/insightdata", {
      name,
      scope,
      type
    });
  }

  async getCollectionSchema(collectionName) {
    return this.client.get(`/insightdata/${encodeURIComponent(collectionName)}/schema`);
  }

  async upsertContactRecord({ contactIdentifier, collectionName, recordId, data }) {
    return this.client.put(
      `/contacts/${encodeURIComponent(contactIdentifier)}/insightdata/${encodeURIComponent(collectionName)}/${encodeURIComponent(recordId)}`,
      data
    );
  }

  async upsertAccountRecord({ collectionName, recordId, data }) {
    return this.client.put(
      `/insightdata/account/${encodeURIComponent(collectionName)}/${encodeURIComponent(recordId)}`,
      data
    );
  }

  async bulkImport(records) {
    return this.client.put("/insightdata/import", records);
  }

  async getBulkImportStatus(importId) {
    return this.client.get(`/insightdata/import/${encodeURIComponent(importId)}`);
  }
}

module.exports = {
  InsightDataService
};
