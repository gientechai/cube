# GBase JDBC Driver Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add support for GBase 8a MPP cluster database to cubejs-jdbc-driver package

**Architecture:** Add GBase configuration to supported-drivers.ts, leveraging existing JDBCDriver infrastructure for connection pooling, query execution, and error handling.

**Tech Stack:** TypeScript, Node.js, JDBC (Java), Maven

---

## Task 1: Add GBase Configuration to supported-drivers.ts

**Files:**
- Modify: `packages/cubejs-jdbc-driver/src/supported-drivers.ts`

**Step 1: Add GBase configuration object**

Add the following configuration to the `SupportedDrivers` object in `supported-drivers.ts`:

```typescript
gbase: {
  driverClass: 'com.gbase.jdbc.Driver',
  prepareConnectionQueries: ['SET time_zone = \'+00:00\''],
  mavenDependency: {
    groupId: 'com.gbase',
    artifactId: 'gbase-connector-java',
    version: '9.5.0.8-build1'
  },
  properties: {
    user: process.env.CUBEJS_DB_USER,
    password: process.env.CUBEJS_DB_PASS,
  },
  jdbcUrl: () => `jdbc:gbase://${process.env.CUBEJS_DB_HOST}:${process.env.CUBEJS_DB_PORT || '5050'}/${process.env.CUBEJS_DB_NAME}`
}
```

This should be added after the `hive` configuration (line 66), maintaining the same structure as other database drivers.

**Step 2: Verify TypeScript compilation**

Run: `cd packages/cubejs-jdbc-driver && yarn tsc`

Expected: No TypeScript errors

**Step 3: Commit**

```bash
git add packages/cubejs-jdbc-driver/src/supported-drivers.ts
git commit -m "feat: add GBase 8a driver configuration"
```

---

## Task 2: Update README.md with GBase Support

**Files:**
- Modify: `packages/cubejs-jdbc-driver/README.md`

**Step 1: Add GBase to supported databases section**

After the "# Cube.js JDBC Database Driver" heading, add a "Supported Databases" section before "## Support":

```markdown
## Supported Databases

This JDBC driver supports the following databases:

- **MySQL** - Production-ready
- **Amazon Athena** - Production-ready
- **Apache Spark SQL** - Production-ready
- **Apache Hive** - Production-ready
- **GBase 8a** - Community supported

```

**Step 2: Add GBase configuration section**

Add before "## Java installation":

```markdown
## GBase 8a Configuration

GBase 8a is an MPP analytical database. To use GBase 8a with Cube.js:

### Environment Variables

Set the following environment variables:

```bash
CUBEJS_DB_HOST=your_gbase_host      # GBase server host
CUBEJS_DB_PORT=5050                 # GBase default port
CUBEJS_DB_NAME=your_database_name   # Database name
CUBEJS_DB_USER=your_username        # Username
CUBEJS_DB_PASS=your_password        # Password
```

### Basic Usage

```javascript
const { JDBCDriver } = require('@cubejs-backend/jdbc-driver');

const driver = new JDBCDriver({
  dataSource: 'gbase',
  dbType: 'gbase'
});

// Execute queries
const results = await driver.query('SELECT * FROM users LIMIT 10', []);
```

### Installing the GBase JDBC Driver

Before using GBase, you need to install the JDBC driver to your Maven repository or use the local JAR file.

#### Option 1: Maven Repository (Recommended)

Deploy the driver to your Maven repository:

```bash
mvn deploy:deploy-file \
  -Dfile=gbase-connector-java-9.5.0.8-build1-bin.jar \
  -DgroupId=com.gbase \
  -DartifactId=gbase-connector-java \
  -Dversion=9.5.0.8-build1 \
  -Dpackaging=jar \
  -DgeneratePom=true \
  -DrepositoryId=my-repo \
  -Durl=https://your-maven-repo.com/repository/maven-public/ \
  -Dusername=your_username \
  -Dpassword='your_password'
```

#### Option 2: Local JAR File

Use the JAR file directly without Maven:

```javascript
const driver = new JDBCDriver({
  dataSource: 'gbase',
  dbType: 'gbase',
  customClassPath: '/path/to/gbase-connector-java-9.5.0.8-build1-bin.jar'
});
```

For detailed GBase setup instructions, see [GBASE.md](./GBASE.md).

```

**Step 3: Commit**

```bash
git add packages/cubejs-jdbc-driver/README.md
git commit -m "docs: add GBase configuration to README"
```

---

## Task 3: Create Detailed GBASE.md Documentation

**Files:**
- Create: `packages/cubejs-jdbc-driver/GBASE.md`

**Step 1: Create comprehensive GBase documentation**

Create the file with the following content:

```markdown
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
CUBEJS_DB_HOST=192.168.3.147
CUBEJS_DB_PORT=5050
CUBEJS_DB_NAME=cube_test
CUBEJS_DB_USER=root
CUBEJS_DB_PASS=gbase123

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
  },

  // Important: Use MySQL dialect for SQL generation
  // GBase 8a is MySQL-compatible, so we use MySQL SQL syntax
  externalDbType: 'mysql'
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
CUBEJS_DB_HOST=192.168.3.147
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
```

**Step 2: Commit**

```bash
git add packages/cubejs-jdbc-driver/GBASE.md
git commit -m "docs: add comprehensive GBase configuration guide"
```

---

## Task 4: Manual Testing with GBase Cluster

**Files:**
- Create: `packages/cubejs-jdbc-driver/test-gbase-connection.js` (temporary test file)

**Step 1: Create test script**

Create a test script to verify the implementation:

```javascript
const { JDBCDriver } = require('@cubejs-backend/jdbc-driver');

async function testGBaseConnection() {
  console.log('Testing GBase JDBC Driver...\n');

  // Test with environment variables
  const driver = new JDBCDriver({
    dataSource: 'gbase',
    dbType: 'gbase',
    customClassPath: '/home/zm/download/gbase-connector-java-9.5.0.8-build1-bin.jar'
  });

  try {
    // Test 1: Connection
    console.log('Test 1: Testing connection...');
    await driver.testConnection();
    console.log('✓ Connection successful\n');

    // Test 2: Simple query
    console.log('Test 2: Testing simple query...');
    const result = await driver.query('SELECT 1 as test_value, NOW() as current_time', []);
    console.log('✓ Query result:', JSON.stringify(result, null, 2));
    console.log();

    // Test 3: Parameterized query
    console.log('Test 3: Testing parameterized query...');
    const paramResult = await driver.query('SELECT ? as value', [42]);
    console.log('✓ Parameterized query result:', JSON.stringify(paramResult, null, 2));
    console.log();

    // Test 4: Get supported drivers
    console.log('Test 4: Verifying driver registration...');
    const supportedDrivers = JDBCDriver.getSupportedDrivers();
    console.log('✓ Supported drivers:', supportedDrivers);
    console.log('✓ GBase registered:', supportedDrivers.includes('gbase'));
    console.log();

    console.log('All tests passed! ✓');

    await driver.release();
  } catch (error) {
    console.error('✗ Test failed:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

testGBaseConnection();
```

**Step 2: Set test environment variables**

```bash
export CUBEJS_DB_HOST=192.168.3.147
export CUBEJS_DB_PORT=5050
export CUBEJS_DB_NAME=cube_test
export CUBEJS_DB_USER=root
export CUBEJS_DB_PASS=gbase123
```

**Step 3: Run test**

```bash
cd packages/cubejs-jdbc-driver
node test-gbase-connection.js
```

Expected output:
```
Testing GBase JDBC Driver...

Test 1: Testing connection...
✓ Connection successful

Test 2: Testing simple query...
✓ Query result: [
  {
    "test_value": 1,
    "current_time": "2026-02-26 12:34:56"
  }
]

Test 3: Testing parameterized query...
✓ Parameterized query result: [
  {
    "value": 42
  }
]

Test 4: Verifying driver registration...
✓ Supported drivers: [ 'mysql', 'athena', 'sparksql', 'hive', 'gbase' ]
✓ GBase registered: true

All tests passed! ✓
```

**Step 4: Clean up test file**

```bash
rm packages/cubejs-jdbc-driver/test-gbase-connection.js
```

**Step 5: Commit test results**

```bash
git commit --allow-empty -m "test: verify GBase driver connection and queries"
```

---

## Task 5: Build and Verify Package

**Files:**
- Build: `packages/cubejs-jdbc-driver/dist/`

**Step 1: Build the package**

```bash
cd packages/cubejs-jdbc-driver
yarn build
```

Expected: No errors, `dist/` directory created with compiled JavaScript

**Step 2: Verify TypeScript compilation**

```bash
yarn tsc
```

Expected: No TypeScript errors

**Step 3: Check compiled output**

```bash
ls -la dist/src/
```

Expected: Should see `supported-drivers.js`, `JDBCDriver.js`, etc.

**Step 4: Verify GBase in compiled code**

```bash
grep -n "gbase" dist/src/supported-drivers.js
```

Expected: Should see gbase configuration in compiled output

**Step 5: Commit (no changes needed, just verification)**

If all builds pass:
```bash
git commit --allow-empty -m "build: verify package builds successfully with GBase support"
```

---

## Task 6: Update CHANGELOG

**Files:**
- Modify: `packages/cubejs-jdbc-driver/CHANGELOG.md`

**Step 1: Add changelog entry**

Add entry at the top of the CHANGELOG (after the heading):

```markdown
## [1.6.3] - 2026-02-26

### Added
- GBase 8a database support (@claude)
  - New driver configuration for GBase 8a MPP cluster
  - Support for GBase JDBC driver via Maven or local JAR
  - Comprehensive GBase setup documentation
  - Automatic timezone configuration (UTC)
  - Connection pooling support

```

**Step 2: Commit**

```bash
git add packages/cubejs-jdbc-driver/CHANGELOG.md
git commit -m "chore: update CHANGELOG for GBase support"
```

---

## Task 7: Final Review and Integration Testing

**Files:**
- Review all modified files

**Step 1: Review all changes**

```bash
cd /home/zm/code/cube
git diff b1.6.2-chukaiping~1 HEAD
```

Verify changes include:
- ✓ GBase configuration in supported-drivers.ts
- ✓ README.md updated with GBase documentation
- ✓ GBASE.md created with comprehensive guide
- ✓ CHANGELOG.md updated

**Step 2: Create comprehensive integration test**

Create `test-gbase-integration.js`:

```javascript
const { JDBCDriver } = require('./index.js');

async function runIntegrationTests() {
  console.log('=== GBase Integration Tests ===\n');

  const driver = new JDBCDriver({
    dataSource: 'gbase',
    dbType: 'gbase',
    customClassPath: '/home/zm/download/gbase-connector-java-9.5.0.8-build1-bin.jar'
  });

  const tests = [
    {
      name: 'Driver Registration',
      test: () => {
        const drivers = JDBCDriver.getSupportedDrivers();
        if (!drivers.includes('gbase')) {
          throw new Error('GBase driver not registered');
        }
        return 'GBase driver registered';
      }
    },
    {
      name: 'Database Connection',
      test: async () => {
        await driver.testConnection();
        return 'Connected successfully';
      }
    },
    {
      name: 'Basic SELECT Query',
      test: async () => {
        const result = await driver.query('SELECT 1 as num, \'test\' as str', []);
        if (result.length !== 1 || result[0].num !== 1) {
          throw new Error('Unexpected result');
        }
        return 'Query executed correctly';
      }
    },
    {
      name: 'Parameterized Query',
      test: async () => {
        const result = await driver.query('SELECT ? * 2 as doubled', [21]);
        if (result[0].doubled !== 42) {
          throw new Error('Parameter binding failed');
        }
        return 'Parameters handled correctly';
      }
    },
    {
      name: 'Timezone Configuration',
      test: async () => {
        const result = await driver.query('SELECT @@session.time_zone as tz', []);
        return `Timezone set to: ${result[0].tz}`;
      }
    }
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      console.log(`Running: ${test.name}`);
      const result = await test.test();
      console.log(`✓ PASS: ${result}\n`);
      passed++;
    } catch (error) {
      console.error(`✗ FAIL: ${error.message}\n`);
      failed++;
    }
  }

  await driver.release();

  console.log('=== Test Summary ===');
  console.log(`Passed: ${passed}/${tests.length}`);
  console.log(`Failed: ${failed}/${tests.length}`);

  if (failed > 0) {
    process.exit(1);
  }
}

runIntegrationTests();
```

**Step 3: Run integration tests**

```bash
cd packages/cubejs-jdbc-driver
node test-gbase-integration.js
```

Expected: All tests pass

**Step 4: Clean up test file**

```bash
rm packages/cubejs-jdbc-driver/test-gbase-integration.js
```

**Step 5: Final commit**

```bash
git add packages/cubejs-jdbc-driver/
git commit -m "feat: complete GBase 8a JDBC driver implementation

- Add GBase configuration to supported-drivers.ts
- Update README.md with GBase setup instructions
- Create comprehensive GBASE.md documentation
- Add CHANGELOG entry
- Test connection and query execution

Tested with:
- GBase 8a cluster: 192.168.3.147:5050
- Database: cube_test
- JDBC Driver: gbase-connector-java-9.5.0.8-build1

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

**Step 6: Push to remote branch (if needed)**

```bash
git push origin b1.6.2-chukaiping
```

---

## Summary

This implementation plan adds complete GBase 8a support to cubejs-jdbc-driver through:

1. **Configuration** - GBase driver settings in supported-drivers.ts
2. **Documentation** - README updates and comprehensive GBASE.md guide
3. **Testing** - Manual test scripts to verify functionality
4. **Quality** - TypeScript compilation, changelog, and integration tests

Total estimated time: 30-45 minutes

All changes follow existing patterns in the codebase and maintain compatibility with other JDBC drivers.
