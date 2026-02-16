const { PendingUser: PendingUserModel } = require('../database/database');

// Create a wrapper class to maintain compatibility with existing code
class PendingUser {
  constructor(data) {
    Object.assign(this, data);
  }
  
  static async findOne(query) {
    const result = await PendingUserModel.findOne(query);
    return result ? new PendingUser(result) : null;
  }
  
  static async deleteOne(query) {
    return await PendingUserModel.deleteOne(query);
  }
  
  static async deleteMany(query) {
    return await PendingUserModel.deleteMany(query);
  }
  
  async save() {
    const result = await PendingUserModel.create(this);
    Object.assign(this, result);
    return this;
  }
}

module.exports = PendingUser;
