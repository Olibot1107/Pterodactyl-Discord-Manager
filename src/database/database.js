const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Create database file in data directory
const dbPath = path.join(__dirname, '../data/database.sqlite');
const db = new sqlite3.Database(dbPath);

// Create tables if they don't exist
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discordId TEXT UNIQUE NOT NULL,
      email TEXT NOT NULL,
      pteroId INTEGER NOT NULL
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS pendingUsers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discordId TEXT NOT NULL,
      email TEXT NOT NULL,
      code TEXT NOT NULL,
      expiresAt INTEGER NOT NULL
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS stickyMessages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guildId TEXT NOT NULL,
      channelId TEXT NOT NULL,
      content TEXT NOT NULL,
      cooldownSeconds INTEGER NOT NULL DEFAULT 5,
      useComponentsV2 INTEGER NOT NULL DEFAULT 0,
      lastStickyMessageId TEXT,
      updatedBy TEXT,
      updatedAt INTEGER NOT NULL
    );
  `);

  db.get(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'stickyMessages'`,
    (schemaErr, schemaRow) => {
      if (schemaErr) {
        console.warn("[DB] Failed to inspect stickyMessages table SQL:", schemaErr.message);
        return;
      }

      db.all(`PRAGMA table_info(stickyMessages)`, (infoErr, columns) => {
        if (infoErr) {
          console.warn("[DB] Failed to inspect stickyMessages schema:", infoErr.message);
          return;
        }

        const tableSql = String(schemaRow?.sql || "");
        const hasSinglePerChannelUnique = /UNIQUE\s*\(\s*guildId\s*,\s*channelId\s*\)/i.test(tableSql);
        const hasUseComponentsV2 =
          Array.isArray(columns) && columns.some((column) => column.name === "useComponentsV2");

        if (hasSinglePerChannelUnique) {
          const useComponentsV2Source = hasUseComponentsV2
            ? "COALESCE(useComponentsV2, 0)"
            : "0";

          db.serialize(() => {
            db.run(
              `
                CREATE TABLE IF NOT EXISTS stickyMessages_new (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  guildId TEXT NOT NULL,
                  channelId TEXT NOT NULL,
                  content TEXT NOT NULL,
                  cooldownSeconds INTEGER NOT NULL DEFAULT 5,
                  useComponentsV2 INTEGER NOT NULL DEFAULT 0,
                  lastStickyMessageId TEXT,
                  updatedBy TEXT,
                  updatedAt INTEGER NOT NULL
                );
              `,
              (createErr) => {
                if (createErr) {
                  console.warn("[DB] Failed to create stickyMessages_new table:", createErr.message);
                  return;
                }

                db.run(
                  `
                    INSERT INTO stickyMessages_new (
                      id,
                      guildId,
                      channelId,
                      content,
                      cooldownSeconds,
                      useComponentsV2,
                      lastStickyMessageId,
                      updatedBy,
                      updatedAt
                    )
                    SELECT
                      id,
                      guildId,
                      channelId,
                      content,
                      cooldownSeconds,
                      ${useComponentsV2Source},
                      lastStickyMessageId,
                      updatedBy,
                      updatedAt
                    FROM stickyMessages
                  `,
                  (copyErr) => {
                    if (copyErr) {
                      console.warn("[DB] Failed to migrate stickyMessages rows:", copyErr.message);
                      db.run(`DROP TABLE IF EXISTS stickyMessages_new`);
                      return;
                    }

                    db.run(`DROP TABLE stickyMessages`, (dropErr) => {
                      if (dropErr) {
                        console.warn("[DB] Failed to drop old stickyMessages table:", dropErr.message);
                        return;
                      }

                      db.run(
                        `ALTER TABLE stickyMessages_new RENAME TO stickyMessages`,
                        (renameErr) => {
                          if (renameErr) {
                            console.warn("[DB] Failed to rename stickyMessages_new table:", renameErr.message);
                          }
                        }
                      );
                    });
                  }
                );
              }
            );
          });

          return;
        }

        if (!hasUseComponentsV2) {
          db.run(
            `ALTER TABLE stickyMessages ADD COLUMN useComponentsV2 INTEGER NOT NULL DEFAULT 0`,
            (alterErr) => {
              if (alterErr) {
                console.warn("[DB] Failed to add useComponentsV2 to stickyMessages:", alterErr.message);
              }
            }
          );
        }
      });
    }
  );
});

// User model functions
const User = {
  findOne: (query) => {
    return new Promise((resolve, reject) => {
      const keys = Object.keys(query);
      const values = Object.values(query);
      const whereClause = keys.map(key => `${key} = ?`).join(' AND ');
      db.get(`SELECT * FROM users WHERE ${whereClause}`, values, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  },
  
  deleteOne: (query) => {
    return new Promise((resolve, reject) => {
      const keys = Object.keys(query);
      const values = Object.values(query);
      const whereClause = keys.map(key => `${key} = ?`).join(' AND ');
      db.run(`DELETE FROM users WHERE ${whereClause}`, values, function(err) {
        if (err) reject(err);
        else resolve({ affectedRows: this.changes });
      });
    });
  },
  
  deleteMany: (query) => {
    return new Promise((resolve, reject) => {
      const keys = Object.keys(query);
      const values = Object.values(query);
      const whereClause = keys.map(key => `${key} = ?`).join(' AND ');
      db.run(`DELETE FROM users WHERE ${whereClause}`, values, function(err) {
        if (err) reject(err);
        else resolve({ affectedRows: this.changes });
      });
    });
  },
  
  create: (data) => {
    return new Promise((resolve, reject) => {
      const keys = Object.keys(data);
      const placeholders = keys.map(() => '?').join(',');
      const values = Object.values(data);
      db.run(`INSERT INTO users (${keys.join(',')}) VALUES (${placeholders})`, values, function(err) {
        if (err) reject(err);
        else resolve({ ...data, id: this.lastID });
      });
    });
  },
  
  save: function() {
    return User.create(this);
  }
};

// PendingUser model functions
const PendingUser = {
  findOne: (query) => {
    return new Promise((resolve, reject) => {
      const keys = Object.keys(query);
      const values = Object.values(query);
      const whereClause = keys.map(key => `${key} = ?`).join(' AND ');
      db.get(`SELECT * FROM pendingUsers WHERE ${whereClause}`, values, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  },
  
  deleteOne: (query) => {
    return new Promise((resolve, reject) => {
      const keys = Object.keys(query);
      const values = Object.values(query);
      const whereClause = keys.map(key => `${key} = ?`).join(' AND ');
      db.run(`DELETE FROM pendingUsers WHERE ${whereClause}`, values, function(err) {
        if (err) reject(err);
        else resolve({ affectedRows: this.changes });
      });
    });
  },
  
  deleteMany: (query) => {
    return new Promise((resolve, reject) => {
      const keys = Object.keys(query);
      const values = Object.values(query);
      const whereClause = keys.map(key => `${key} = ?`).join(' AND ');
      db.run(`DELETE FROM pendingUsers WHERE ${whereClause}`, values, function(err) {
        if (err) reject(err);
        else resolve({ affectedRows: this.changes });
      });
    });
  },
  
  create: (data) => {
    return new Promise((resolve, reject) => {
      const keys = Object.keys(data);
      const placeholders = keys.map(() => '?').join(',');
      const values = Object.values(data);
      db.run(`INSERT INTO pendingUsers (${keys.join(',')}) VALUES (${placeholders})`, values, function(err) {
        if (err) reject(err);
        else resolve({ ...data, id: this.lastID });
      });
    });
  },
  
  save: function() {
    return PendingUser.create(this);
  }
};

// StickyMessage model functions
const StickyMessage = {
  findOne: (query) => {
    return new Promise((resolve, reject) => {
      const keys = Object.keys(query);
      const values = Object.values(query);
      const whereClause = keys.map(key => `${key} = ?`).join(' AND ');
      db.get(`SELECT * FROM stickyMessages WHERE ${whereClause}`, values, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  },

  findMany: (query = {}, options = {}) => {
    return new Promise((resolve, reject) => {
      const keys = Object.keys(query);
      const values = Object.values(query);
      const whereClause = keys.length
        ? ` WHERE ${keys.map(key => `${key} = ?`).join(' AND ')}`
        : '';
      const orderByClause = options.orderBy ? ` ORDER BY ${options.orderBy}` : '';
      db.all(
        `SELECT * FROM stickyMessages${whereClause}${orderByClause}`,
        values,
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });
  },

  create: (data) => {
    return new Promise((resolve, reject) => {
      const keys = Object.keys(data);
      const placeholders = keys.map(() => '?').join(',');
      const values = Object.values(data);
      db.run(
        `INSERT INTO stickyMessages (${keys.join(',')}) VALUES (${placeholders})`,
        values,
        function(err) {
          if (err) reject(err);
          else resolve({ ...data, id: this.lastID });
        }
      );
    });
  },

  updateOne: (query, updates) => {
    return new Promise((resolve, reject) => {
      const queryKeys = Object.keys(query);
      const queryValues = Object.values(query);
      const updateKeys = Object.keys(updates);
      const updateValues = Object.values(updates);

      if (!updateKeys.length) return resolve({ affectedRows: 0 });

      const whereClause = queryKeys.map(key => `${key} = ?`).join(' AND ');
      const setClause = updateKeys.map(key => `${key} = ?`).join(', ');

      db.run(
        `UPDATE stickyMessages SET ${setClause} WHERE ${whereClause}`,
        [...updateValues, ...queryValues],
        function(err) {
          if (err) reject(err);
          else resolve({ affectedRows: this.changes });
        }
      );
    });
  },

  deleteOne: (query) => {
    return new Promise((resolve, reject) => {
      const keys = Object.keys(query);
      const values = Object.values(query);
      const whereClause = keys.map(key => `${key} = ?`).join(' AND ');
      db.run(`DELETE FROM stickyMessages WHERE ${whereClause}`, values, function(err) {
        if (err) reject(err);
        else resolve({ affectedRows: this.changes });
      });
    });
  },

  deleteMany: (query) => {
    return new Promise((resolve, reject) => {
      const keys = Object.keys(query);
      const values = Object.values(query);
      const whereClause = keys.map(key => `${key} = ?`).join(' AND ');
      db.run(`DELETE FROM stickyMessages WHERE ${whereClause}`, values, function(err) {
        if (err) reject(err);
        else resolve({ affectedRows: this.changes });
      });
    });
  }
};

module.exports = { db, User, PendingUser, StickyMessage };
