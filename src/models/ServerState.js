const { ServerState: ServerStateModel } = require('../database/database');

class ServerState {
  constructor(data) {
    Object.assign(this, data);
  }

  static async findOne(query) {
    const result = await ServerStateModel.findOne(query);
    return result ? new ServerState(result) : null;
  }

  static async upsert(data) {
    return await ServerStateModel.upsert(data);
  }
}

module.exports = ServerState;
