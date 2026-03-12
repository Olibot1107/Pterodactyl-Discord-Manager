const { ServerWebhook: ServerWebhookModel } = require('../database/database');

class ServerWebhook {
  constructor(data) {
    Object.assign(this, data);
  }

  static async findOne(query) {
    const result = await ServerWebhookModel.findOne(query);
    return result ? new ServerWebhook(result) : null;
  }

  static async findMany(query = {}, options = {}) {
    const results = await ServerWebhookModel.findMany(query, options);
    return results.map(row => new ServerWebhook(row));
  }

  static async upsert(data) {
    return await ServerWebhookModel.upsert(data);
  }

  static async deleteOne(query) {
    return await ServerWebhookModel.deleteOne(query);
  }
}

module.exports = ServerWebhook;
