const { StickyMessage: StickyMessageModel } = require("../database/database");

class StickyMessage {
  constructor(data) {
    Object.assign(this, data);
  }

  static async findOne(query) {
    const result = await StickyMessageModel.findOne(query);
    return result ? new StickyMessage(result) : null;
  }

  static async findMany(query = {}, options = {}) {
    const results = await StickyMessageModel.findMany(query, options);
    return results.map((row) => new StickyMessage(row));
  }

  static async create(data) {
    const result = await StickyMessageModel.create(data);
    return new StickyMessage(result);
  }

  static async updateOne(query, updates) {
    return StickyMessageModel.updateOne(query, updates);
  }

  static async deleteOne(query) {
    return StickyMessageModel.deleteOne(query);
  }

  static async deleteMany(query) {
    return StickyMessageModel.deleteMany(query);
  }
}

module.exports = StickyMessage;
