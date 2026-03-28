const { AiApiKey: AiApiKeyModel } = require('../database/database');

class AiApiKey {
  constructor(data) {
    Object.assign(this, data);
  }

  static async findOne(query) {
    const result = await AiApiKeyModel.findOne(query);
    return result ? new AiApiKey(result) : null;
  }

  static async create(data) {
    const result = await AiApiKeyModel.create(data);
    return result ? new AiApiKey(result) : null;
  }

  static async deleteOne(query) {
    return await AiApiKeyModel.deleteOne(query);
  }
}

module.exports = AiApiKey;
