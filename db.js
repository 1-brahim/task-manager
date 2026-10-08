const mysql = require('mysql2/promise');
module.exports = mysql.createPool({
  host: process.env.RDS_HOSTNAME || process.env.DB_HOST || 'localhost',
  port: process.env.RDS_PORT || process.env.DB_PORT || 3306,
  user: process.env.RDS_USERNAME || process.env.DB_USER || 'root',
  password: process.env.RDS_PASSWORD || process.env.DB_PASSWORD || '',
  database: process.env.RDS_DB_NAME || process.env.DB_NAME || 'taskmanager',
  dateStrings: true,
  connectionLimit: 10
});
