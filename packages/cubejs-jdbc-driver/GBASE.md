# GBase 8a JDBC Driver Guide

This guide covers using Cube.js with GBase 8a MPP cluster database.

## About GBase 8a

GBase 8a is a Massively Parallel Processing (MPP) analytical database designed for data warehousing and analytics. It provides high-performance query processing across clustered nodes.

## Prerequisites

- Java 8 or higher installed
- GBase 8a server accessible
- GBase JDBC driver: `gbase-connector-java-9.5.0.8-build1-bin.jar` or compatible version

## Installation

### Step 1: Install GBase JDBC Driver to Maven Repository

Deploy the driver JAR to your Maven repository:

```bash
# WARNING: Avoid passing passwords directly in CLI as they will be saved in shell history.
# Consider using Maven settings.xml for credentials instead.
mvn deploy:deploy-file \
  -Dfile=gbase-connector-java-9.5.0.8-build1-bin.jar \
  -DgroupId=com.gbase \
  -DartifactId=gbase-connector-java \
  -Dversion=9.5.0.8-build1 \
  -Dpackaging=jar \
  -DgeneratePom=true \
  -DrepositoryId=gbase-repo \
  -Durl=https://your-maven-repo.com/repository/maven-public/ \
  -Dusername=admin \
  -Dpassword='your_password'
```

### Step 2: Configure Environment Variables

Create a `.env` file or set environment variables:

```bash
# Database Connection
CUBEJS_DB_HOST=your-gbase-host.example.com
CUBEJS_DB_PORT=5050
CUBEJS_DB_NAME=your_database_name
CUBEJS_DB_USER=your_username
CUBEJS_DB_PASS=your_secure_password

# Maven Repository (if using private repository)
MAVEN_REPO_URL=https://your-maven-repo.com/repository/maven-public/
MAVEN_REPO_USERNAME=admin
MAVEN_REPO_PASSWORD=your_password
```

### Step 3: Create Cube.js Configuration

In your `cube.js` file:

```javascript
const { JDBCDriver } = require('@cubejs-backend/jdbc-driver');

module.exports = {
  dialectFactory: () => {
    return new JDBCDriver({
      dataSource: 'gbase',
      dbType: 'gbase'
    });
  }
};
```

## Connection Options

### Single Node Connection

Connect to a specific GBase node:

```javascript
const driver = new JDBCDriver({
  dataSource: 'gbase',
  dbType: 'gbase'
});
```

With environment variables:
```bash
CUBEJS_DB_HOST=your-gbase-host.example.com
CUBEJS_DB_PORT=5050
```

### Using Local JAR File

Bypass Maven and use local JAR:

```javascript
const driver = new JDBCDriver({
  dataSource: 'gbase',
  dbType: 'gbase',
  customClassPath: '/absolute/path/to/gbase-connector-java-9.5.0.8-build1-bin.jar'
});
```

### Custom Pool Configuration

Adjust connection pool settings:

```javascript
const driver = new JDBCDriver({
  dataSource: 'gbase',
  dbType: 'gbase',
  maxPoolSize: 20,  // Default: 8
  testConnectionTimeout: 30000  // Default: 60000 (ms)
});
```

## SQL Compatibility

GBase 8a is mostly compatible with MySQL. The driver:

- Uses MySQL-style parameter escaping
- Sets timezone to UTC on connection (`SET time_zone = '+00:00'`)
- Supports standard SQL SELECT, INSERT, UPDATE, DELETE operations
- Compatible with most MySQL functions

### Known Differences

Some GBase-specific functions may differ from MySQL. Test complex queries before deployment.

## Testing Your Connection

Create a test script `test-connection.js`:

```javascript
const { JDBCDriver } = require('@cubejs-backend/jdbc-driver');

async function testConnection() {
  const driver = new JDBCDriver({
    dataSource: 'gbase',
    dbType: 'gbase'
  });

  try {
    // Test connection
    await driver.testConnection();
    console.log('✓ Connection successful');

    // Test query
    const result = await driver.query('SELECT 1 as test_value', []);
    console.log('✓ Query result:', result);

    await driver.release();
  } catch (error) {
    console.error('✗ Connection failed:', error.message);
    process.exit(1);
  }
}

testConnection();
```

Run with: `node test-connection.js`

## Troubleshooting

### JVM Not Started

**Error:** `Java JVM is not running`

**Solution:** Ensure Java is installed and JAVA_HOME is set:

```bash
java -version
echo $JAVA_HOME
```

### Driver Class Not Found

**Error:** `com.gbase.jdbc.Driver not found`

**Solutions:**
1. Verify JAR is deployed to Maven repository correctly
2. Check Maven repository credentials and URL
3. Use `customClassPath` to point to local JAR file
4. Verify JAR file is not corrupted

### Connection Refused

**Error:** `Could not create connection to database server`

**Solutions:**
1. Verify GBase server is running: `telnet <host> 5050`
2. Check firewall settings
3. Verify host, port, and database name
4. Check GBase server logs for connection attempts

### Authentication Failed

**Error:** `Access denied for user`

**Solutions:**
1. Verify username and password
2. Check user has permissions for the database
3. Ensure user can connect from the client IP address

### Timezone Errors

**Error:** `Unknown or incorrect time zone`

**Solution:** The driver automatically sets UTC timezone. If issues persist, verify GBase timezone configuration.

## Performance Tips

1. **Connection Pooling:** Increase `maxPoolSize` for high-concurrency scenarios
2. **Query Optimization:** Use GBase's MPP capabilities with proper partitioning
3. **Batch Operations:** Use transactions for bulk inserts/updates
4. **Limit Results:** Always use LIMIT in development queries

## Advanced Configuration

### Maven Repository Authentication

For private Maven repositories, set environment variables:

```bash
export MAVEN_REPO_USERNAME=admin
export MAVEN_REPO_PASSWORD='your_password'
export MAVEN_REPO_URL=https://your-repo.com/repository/maven-public/
```

### Custom Initialization Queries

Add custom queries to run on connection (advanced):

```javascript
const driver = new JDBCDriver({
  dataSource: 'gbase',
  dbType: 'gbase',
  prepareConnectionQueries: [
    'SET time_zone = \'+00:00\'',
    'SET sql_mode = \'ANSI_QUOTES\''
  ]
});
```

## Support

For GBase-specific issues:
- Consult GBase 8a documentation
- Contact GBase support
- Check Cube.js community forums

For JDBC driver issues:
- Verify driver version compatibility
- Check Java version requirements
- Review GBase JDBC driver documentation
