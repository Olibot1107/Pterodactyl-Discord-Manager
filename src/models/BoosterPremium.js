const { BoosterPremium: BoosterPremiumModel } = require("../database/database");

class BoosterPremium {
  constructor(data) {
    Object.assign(this, data);
  }

  static async findOne(query) {
    const result = await BoosterPremiumModel.findOne(query);
    return result ? new BoosterPremium(result) : null;
  }

  static async create(data) {
    const result = await BoosterPremiumModel.create(data);
    return new BoosterPremium(result);
  }

  static async deleteOne(query) {
    return BoosterPremiumModel.deleteOne(query);
  }
}

module.exports = BoosterPremium;
