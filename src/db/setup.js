// bigfix-backend/src/db/setup.js
const sql = require('mssql');
const { getCfg } = require('../env');
const { logger } = require('../services/logger');

async function runDatabaseSetup() {
  const cfg = getCfg();
  
  const masterConfig = {
    user: cfg.SQL_SERVER_AUTHENTICATION_USERNAME,
    password: cfg.SQL_SERVER_AUTHENTICATION_PASSWORD,
    server: cfg.SQL_SERVER,
    port: Number(cfg.SQL_PORT || 1433),
    database: 'master', 
    options: { encrypt: true, trustServerCertificate: true }
  };

  const dbName = cfg.DATABASENAME || 'BESSetu';
  let pool = null;

  try {
    logger.info(`[DB Setup] Connecting to SQL Server...`);
    pool = await new sql.ConnectionPool(masterConfig).connect();

    // 1. Create DB if needed
    const dbCheck = await pool.request().query(`SELECT name FROM sys.databases WHERE name = '${dbName}'`);
    if (dbCheck.recordset.length === 0) {
      await pool.request().query(`CREATE DATABASE [${dbName}]`);
    }
    await pool.close(); 

    // 2. Connect to App DB
    const appDbConfig = { ...masterConfig, database: dbName };
    pool = await new sql.ConnectionPool(appDbConfig).connect();

    // 3. Create Standard Tables
    await pool.request().query(`
      IF OBJECT_ID('dbo.USERS', 'U') IS NULL
      CREATE TABLE dbo.USERS (
          [UserID] INT NOT NULL PRIMARY KEY,
          [LoginName] NVARCHAR(128) NOT NULL,
          [PasswordHash] NVARCHAR(128) NULL,
          [PasswordSalt] NVARCHAR(128) NULL,
          [PasswordHistory] VARBINARY(MAX) NULL,
          [HashAlgorithm] NVARCHAR(12) NOT NULL,
          [CreatedAt] DATETIME2(3) DEFAULT GETUTCDATE(),
          [UpdatedAt] DATETIME2(3) DEFAULT GETUTCDATE(),
          [AppState] NVARCHAR(MAX) NULL,
          [Role] NVARCHAR(20) DEFAULT 'Windows'
      );
      
      IF OBJECT_ID('dbo.ActionHistory', 'U') IS NULL
      CREATE TABLE dbo.ActionHistory (
          [ActionID] INT NOT NULL PRIMARY KEY,
          [Metadata] NVARCHAR(MAX) NULL,
          [PostMailSent] BIT DEFAULT 0,
          [CreatedAt] DATETIME2(7) DEFAULT SYSUTCDATETIME()
      );

      IF OBJECT_ID('dbo.AssetOwnership', 'U') IS NULL
      CREATE TABLE dbo.AssetOwnership (
          AssetID INT IDENTITY(1,1) PRIMARY KEY,
          BigFixID NVARCHAR(255) NOT NULL,
          AssetName NVARCHAR(255) NOT NULL,
          AssetType NVARCHAR(50) NOT NULL,
          CreatedByRole NVARCHAR(50) NOT NULL,
          CreatedAt DATETIME DEFAULT SYSUTCDATETIME()
      );
    `);

    // 4. SystemState
    await pool.request().query(`
      IF OBJECT_ID('dbo.SystemState', 'U') IS NULL
      BEGIN
          CREATE TABLE dbo.SystemState (
              [StateKey] NVARCHAR(50) NOT NULL PRIMARY KEY,
              [StateValue] NVARCHAR(MAX) NULL,
              [UpdatedAt] DATETIME2(3) DEFAULT SYSUTCDATETIME()
          );
          INSERT INTO dbo.SystemState (StateKey, StateValue) VALUES ('Windows', '{}');
          INSERT INTO dbo.SystemState (StateKey, StateValue) VALUES ('Linux', '{}');
      END
    `);
    
    // 5. SnapshotHistory
    await pool.request().query(`
      IF OBJECT_ID('dbo.SnapshotHistory', 'U') IS NULL
      CREATE TABLE dbo.SnapshotHistory (
          [Id] INT IDENTITY(1,1) PRIMARY KEY,
          [VmId] NVARCHAR(100) NOT NULL,
          [VmName] NVARCHAR(255) NOT NULL,
          [SnapshotName] NVARCHAR(255) NOT NULL,
          [Type] NVARCHAR(50) DEFAULT 'Snapshot',
          [TaskId] NVARCHAR(100) NULL,
          [Status] NVARCHAR(50) DEFAULT 'queued',
          [Error] NVARCHAR(MAX) NULL,
          [CreatedAt] DATETIME2(3) DEFAULT SYSUTCDATETIME()
      );
    `);

    // --- 6. PatchSchedule Table (UPDATED) ---
    // Added [OperatingSystem] column
    await pool.request().query(`
      IF OBJECT_ID('dbo.PatchSchedule', 'U') IS NULL
      CREATE TABLE dbo.PatchSchedule (
          [Id] INT IDENTITY(1,1) PRIMARY KEY,
          [ServerName] NVARCHAR(255) NOT NULL,
          [Day] INT NOT NULL,
          [MonthIndex] INT NOT NULL,
          [Year] INT NOT NULL,
          [Time] NVARCHAR(50) NOT NULL,
          [OperatingSystem] NVARCHAR(50) DEFAULT 'Windows', -- NEW COLUMN
          [CreatedAt] DATETIME2(3) DEFAULT SYSUTCDATETIME()
      );
    `);

    // Auto-Migration for existing tables
    try {
      const colCheck = await pool.request().query(`
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_NAME = 'PatchSchedule' AND COLUMN_NAME = 'OperatingSystem'
      `);
      if (colCheck.recordset.length === 0) {
        logger.info("[DB Setup] Adding missing 'OperatingSystem' column to PatchSchedule...");
        await pool.request().query(`ALTER TABLE dbo.PatchSchedule ADD [OperatingSystem] NVARCHAR(50) DEFAULT 'Windows' WITH VALUES`);
      }
    } catch(e) { logger.warn("PatchSchedule migration check failed: " + e.message); }

    // --- 7. Shared User Restoration ---
    if ((await pool.request().query(`SELECT 1 FROM dbo.USERS WHERE UserID = 9002`)).recordset.length === 0) {
      await pool.request().query(`INSERT INTO dbo.USERS (UserID, LoginName, HashAlgorithm, Role) VALUES (9002, 'shared_windows', 'PBKDF2', 'Windows')`);
    }
    if ((await pool.request().query(`SELECT 1 FROM dbo.USERS WHERE UserID = 9003`)).recordset.length === 0) {
      await pool.request().query(`INSERT INTO dbo.USERS (UserID, LoginName, HashAlgorithm, Role) VALUES (9003, 'shared_linux', 'PBKDF2', 'Linux')`);
    }

    logger.info("[DB Setup] Database initialization complete.");

  } catch (err) {
    logger.error(`[DB Setup] Critical Error: ${err.message}`);
    throw err;
  } finally {
    if (pool) await pool.close();
  }
}

module.exports = { runDatabaseSetup };