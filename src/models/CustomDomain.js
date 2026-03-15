const { CustomDomain: CustomDomainModel } = require('../database/database');

class CustomDomain {
  constructor(data) {
    Object.assign(this, data);
  }

  static async findOne(query) {
    const result = await CustomDomainModel.findOne(query);
    return result ? new CustomDomain(result) : null;
  }

  static async findMany(query = {}, options = {}) {
    const results = await CustomDomainModel.findMany(query, options);
    return results.map(row => new CustomDomain(row));
  }

  static async upsert(data) {
    return await CustomDomainModel.upsert(data);
  }

  static async deleteOne(query) {
    return await CustomDomainModel.deleteOne(query);
  }
}

module.exports = CustomDomain;
