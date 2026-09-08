# Cube.js GBase Driver

Native Node.js driver for [GBase 8a](https://www.gbase.cn/) MPP analytical database.

GBase 8a speaks a MySQL-compatible wire protocol. This driver extends
`@cubejs-backend/mysql-driver` with GBase-specific defaults (port `5050`, UTC
session timezone) so you do not need Java/JDBC.

## Configuration

Set environment variables:

```bash
CUBEJS_DB_TYPE=gbase
CUBEJS_DB_HOST=your-gbase-host
CUBEJS_DB_PORT=5050
CUBEJS_DB_NAME=your_database
CUBEJS_DB_USER=your_username
CUBEJS_DB_PASS=your_password
```

Or configure programmatically in `cube.js`:

```javascript
module.exports = {
  dbType: 'gbase',
};
```

## Notes

- SQL generation uses the MySQL dialect (`MysqlQuery`) because GBase 8a is
  MySQL-compatible.
- No JVM or JDBC JAR installation is required.
- Default port is `5050` when `CUBEJS_DB_PORT` is omitted.
