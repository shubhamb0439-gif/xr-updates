// backend/db/database-config.js
require('dotenv').config();
const { Sequelize } = require('sequelize');
 
 
let sequelize;
 
const AZURE_ENV = process.env.AZURE_ENV;
 
// Choose auth mode based on environment
if (AZURE_ENV === 'DEVELOPMENT' || AZURE_ENV === 'PRODUCTION' || AZURE_ENV === 'STAGING') {
  // Managed Identity (User Assigned)
  sequelize = new Sequelize(process.env.DB_NAME, process.env.AZURE_CLIENT_ID_MI, '', {
    host: process.env.DB_SERVER,
    port: parseInt(process.env.DB_PORT, 10),
    dialect: 'mssql',
    dialectOptions: {
      authentication: {
        type: 'azure-active-directory-msi-app-service',
        options: {
          clientId: process.env.AZURE_CLIENT_ID_MI,
        },
      },
      encrypt: true,
    },
    logging: false,
  });
} else {
  // Service Principal (local/dev fallback)
  sequelize = new Sequelize(process.env.DB_NAME, process.env.DB_CLIENT_ID, process.env.DB_CLIENT_SECRET, {
    host: process.env.DB_SERVER,
    port: parseInt(process.env.DB_PORT, 10),
    dialect: 'mssql',
    dialectOptions: {
      authentication: {
        type: 'azure-active-directory-service-principal-secret',
        options: {
          clientId: process.env.DB_CLIENT_ID,
          clientSecret: process.env.DB_CLIENT_SECRET,
          tenantId: process.env.DB_TENANT_ID,
        },
      },
      encrypt: true,
    },
    logging: false,
  });
}
 
// Call this once during server bootstrap
async function connectToDatabase() {
  try {
    await sequelize.authenticate();
    console.log('✅ Connected to Azure SQL Database');
 
    // If you have Sequelize models, define/import them before sync.
    await sequelize.sync({ alter: false });
    console.log('✅ Database synced');
  } catch (err) {
    console.error('❌ Database connection/sync error:', err);
    throw err; // Let server.js decide how to handle
  }
}
 
// Optional: graceful shutdown helper
async function closeDatabase() {
  try {
    await sequelize.close();
    console.log('🛑 Database connection closed');
  } catch (err) {
    console.error('Error closing database connection:', err);
  }
}
 
module.exports = { sequelize, connectToDatabase, closeDatabase };