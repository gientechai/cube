<p align="center"><a href="https://cube.dev"><img src="https://i.imgur.com/zYHXm4o.png" alt="Cube.js" width="300px"></a></p>

[Website](https://cube.dev) • [Docs](https://cube.dev/docs) • [Blog](https://cube.dev/blog) • [Slack](https://slack.cube.dev) • [Twitter](https://twitter.com/the_cube_dev)

[![npm version](https://badge.fury.io/js/%40cubejs-backend%2Fserver.svg)](https://badge.fury.io/js/%40cubejs-backend%2Fserver)
[![GitHub Actions](https://github.com/cube-js/cube.js/workflows/Build/badge.svg)](https://github.com/cube-js/cube.js/actions?query=workflow%3ABuild+branch%3Amaster)

# Cube.js GaussDB Database Driver

JDBC driver for GaussDB 507 centralized primary/standby V2.0-10.0.0 databases
in `PG` compatibility mode. Uses the customer-supplied `gsjdbc200.jar`.

## Configuration

Set environment variables:

```dotenv
CUBEJS_DB_TYPE=gaussdb
CUBEJS_DB_HOST=your_gaussdb_host
CUBEJS_DB_PORT=your_gaussdb_port
CUBEJS_DB_NAME=your_database
CUBEJS_DB_USER=your_username
CUBEJS_DB_PASS=your_password
CUBEJS_JDBC_CUSTOM_CLASSPATH=drivers
```

Place `gsjdbc200.jar` in the application's `drivers` directory. Start locally
from `cubejs`; the container working directory is `/cube/conf`. Both environments
use the same relative classpath setting shown above.

Or configure programmatically in `cube.js`:

```javascript
const { GaussDBDriver } = require('@cubejs-backend/gaussdb-driver');

module.exports = {
  dbType: 'gaussdb',
  driverFactory: () => new GaussDBDriver({
    url: process.env.CUBEJS_JDBC_URL,
    user: process.env.CUBEJS_DB_USER,
    password: process.env.CUBEJS_DB_PASS,
    schema: 'your_schema',
  }),
};
```

Use a `jdbc:gaussdb://host:port/database` URL or supply explicit host, port and
database settings. Schema is optional and is separate from the database name.
JDBC options such as SSL can be passed through `properties`.

## Notes

- Extends `JDBCDriver` to reuse its connection pool and JVM loading.
  Requires a Java runtime and the JDBC bridge used by `@cubejs-backend/jdbc-driver`.
  GaussDB initializes each acquired connection once before its first query;
  initialization failures destroy the connection. No parent initialization hook is required.
- The JDBC driver class is `com.huawei.gauss200.jdbc.Driver`.
- SQL generation uses the independent `GaussDBQuery` dialect, copied from this
  fork's PostgreSQL dialect and adapted to JDBC `?` parameters.
- `numeric` and `bigint` results are returned as strings to preserve precision.
  Pass unsafe JavaScript integers as `bigint` or exact decimal strings.
- Connections use UTC. `executionTimeout` is in seconds and defaults to `600`.
- Restart after changing JARs because the shared JVM loads its classpath once.
  Set `CUBEJS_JDBC_DISABLE_MVN=true` when all JDBC dependencies are provided locally.
  Other JDBC drivers sharing the JVM must have their JARs present before startup.
- Use matching custom Cube driver and schema-compiler packages. Target
  database compatibility still requires integration verification; this driver
  does not establish support for GaussDB (DWS) or openGauss.

## License

Cube.js GaussDB driver is [Apache 2.0 licensed](https://www.apache.org/licenses/LICENSE-2.0).
