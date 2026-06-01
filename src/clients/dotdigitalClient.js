const axios = require("axios");

class DotdigitalClient {
  constructor({ baseUrl, username, password }) {
    this.http = axios.create({
      baseURL: baseUrl,
      auth: {
        username,
        password
      },
      headers: {
        "Content-Type": "application/json"
      },
      timeout: 30000
    });
  }

  async request(config) {
    try {
      const response = await this.http.request(config);
      return response.data;
    } catch (error) {
      if (error.response) {
        const { status, data } = error.response;
        throw new Error(`Dotdigital API error (${status}): ${JSON.stringify(data)}`);
      }

      throw error;
    }
  }

  get(url, params) {
    return this.request({ method: "GET", url, params });
  }

  post(url, data) {
    return this.request({ method: "POST", url, data });
  }

  put(url, data) {
    return this.request({ method: "PUT", url, data });
  }

  patch(url, data) {
    return this.request({ method: "PATCH", url, data });
  }

  delete(url) {
    return this.request({ method: "DELETE", url });
  }
}

module.exports = {
  DotdigitalClient
};
