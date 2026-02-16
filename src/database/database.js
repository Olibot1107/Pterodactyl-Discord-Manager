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

module.exports = { db, User, PendingUser };
