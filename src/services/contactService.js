class ContactService {
  constructor(client) {
    this.client = client;
  }

  async createContact({ email, firstName, lastName, dataFields = {} }) {
    const payload = {
      email,
      firstName,
      lastName,
      dataFields
    };

    return this.client.post("/contacts", payload);
  }

  async upsertContactByIdentifier(identifier, payload) {
    const encodedIdentifier = encodeURIComponent(identifier);
    return this.client.patch(`/contacts/${encodedIdentifier}`, payload);
  }

  async getContact(identifier) {
    const encodedIdentifier = encodeURIComponent(identifier);
    return this.client.get(`/contacts/${encodedIdentifier}`);
  }
}

module.exports = {
  ContactService
};
