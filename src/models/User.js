const { User: UserModel } = require('../database/database');

// Create a wrapper class to maintain compatibility with existing code
class User {
  constructor(data) {
    Object.assign(this, data);
  }
  
  static async findOne(query) {
    const result = await UserModel.findOne(query);
    return result ? new User(result) : null;
  }
  
  static async deleteOne(query) {
    return await UserModel.deleteOne(query);
  }
  
  static async deleteMany(query) {
    return await UserModel.deleteMany(query);
  }
  
  async save() {
    const result = await UserModel.create(this);
    Object.assign(this, result);
    return this;
  }
}

module.exports = User;
