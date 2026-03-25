const { PendingAccountDeletion: PendingAccountDeletionModel } = require("../database/database");

class PendingAccountDeletion {
  constructor(data) {
    Object.assign(this, data);
  }

  static async findOne(query) {
    const result = await PendingAccountDeletionModel.findOne(query);
    return result ? new PendingAccountDeletion(result) : null;
  }

  static async findExpired(timestamp, limit) {
    const results = await PendingAccountDeletionModel.findExpired(timestamp, limit);
    return results.map((row) => new PendingAccountDeletion(row));
  }

  static async upsert(data) {
    const result = await PendingAccountDeletionModel.upsert(data);
    return new PendingAccountDeletion(result);
  }

  static async deleteOne(query) {
    return PendingAccountDeletionModel.deleteOne(query);
  }
}

module.exports = PendingAccountDeletion;

