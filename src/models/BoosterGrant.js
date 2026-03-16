const { BoosterGrant: BoosterGrantModel } = require("../database/database");

class BoosterGrant {
  constructor(data) {
    Object.assign(this, data);
  }

  static async findOne(query) {
    const result = await BoosterGrantModel.findOne(query);
    return result ? new BoosterGrant(result) : null;
  }

  static async findExpired(timestamp) {
    const results = await BoosterGrantModel.findExpired(timestamp);
    return results.map((row) => new BoosterGrant(row));
  }

  static async upsert(data) {
    const result = await BoosterGrantModel.upsert(data);
    return new BoosterGrant(result);
  }

  static async deleteOne(query) {
    return BoosterGrantModel.deleteOne(query);
  }
}

module.exports = BoosterGrant;
