# GBase 8a JDBC Driver Design

**Date:** 2026-02-26
**Author:** Claude Code
**Status:** Approved

## Overview

Add support for GBase 8a MPP cluster database to the `cubejs-jdbc-driver` package.

## Background

GBase 8a is an analytical MPP (Massively Parallel Processing) cluster database system. This design adds native support for GBase 8a through its JDBC driver, enabling Cube.js to query GBase databases.

### GBase Environment

- **Cluster Nodes:** 192.168.3.147, 192.168.3.148, 192.168.3.149
- **Port:** 5050
- **Test Database:** cube_test
- **Credentials:** root/gbase123
- **JDBC Driver:** gbase-connector-java-9.5.0.8-build1-bin.jar

## Architecture

```
User Application → cubejs-jdbc-driver → JDBCDriver Class
                                              ↓
                                        GBase Configuration
                                              ↓
                                      GBase JDBC Driver
                                              ↓
                                        GBase 8a Cluster
```

## Implementation Details

### 1. Driver Configuration

Add GBase configuration to `src/supported-drivers.ts`:

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

### 2. Environment Variables

- `CUBEJS_DB_HOST` - GBase server host address (single node)
- `CUBEJS_DB_PORT` - Port number (default: 5050)
- `CUBEJS_DB_NAME` - Database name
- `CUBEJS_DB_USER` - Username
- `CUBEJS_DB_PASS` - Password

### 3. Maven Repository Configuration

**Private Repository URL:**
```
https://maven.nexus.dev.gientechai.com/repository/maven-public/
```

**Authentication:**
- Username: admin
- Password: Nexus@123$%^

**Pre-installation Required:**

Users must deploy the GBase JDBC driver to their private Maven repository:

```bash
mvn deploy:deploy-file \
  -Dfile=gbase-connector-java-9.5.0.8-build1-bin.jar \
  -DgroupId=com.gbase \
  -DartifactId=gbase-connector-java \
  -Dversion=9.5.0.8-build1 \
  -Dpackaging=jar \
  -DgeneratePom=true \
  -DrepositoryId=my-repo \
  -Durl=https://maven.nexus.dev.gientechai.com/repository/maven-public/ \
  -Dusername=admin \
  -Dpassword='Nexus@123$%^'
```

### 4. Alternative: Local JAR File

Users can bypass Maven and use the local JAR file directly:

```javascript
const driver = new JDBCDriver({
  dataSource: 'gbase',
  dbType: 'gbase',
  customClassPath: '/path/to/gbase-connector-java-9.5.0.8-build1-bin.jar'
});
```

### 5. Usage Example

```javascript
const { JDBCDriver } = require('@cubejs-backend/jdbc-driver');

// Configure with environment variables
const driver = new JDBCDriver({
  dataSource: 'gbase',
  dbType: 'gbase'
});

// Execute query
const results = await driver.query('SELECT * FROM users LIMIT 10', []);
```

## Data Flow

1. User creates JDBCDriver with `dbType: 'gbase'`
2. Driver loads GBase configuration from `SupportedDrivers`
3. Initializes JVM with GBase JDBC driver in classpath
4. Creates connection pool using configured JDBC URL
5. On query execution:
   - Acquires connection from pool
   - Executes prepare query: `SET time_zone = '+00:00'`
   - Executes user query
   - Transforms result set
   - Releases connection back to pool

## Error Handling

- **Connection Errors:** Captured and transformed to friendly messages
- **Query Errors:** JDBC exception messages returned as-is
- **Pool Errors:** Monitored via `databasePoolError()`
- **Connection Validation:** 60-second timeout for validation checks

## SQL Compatibility

GBase 8a is mostly compatible with MySQL. The implementation:
- Uses MySQL-style parameter escaping (via `sqlstring` package)
- Sets timezone on connection initialization
- Inherits type conversion from BaseDriver
- May need minor adjustments for GBase-specific SQL functions

## Testing Strategy

### Manual Testing Checklist

- [ ] Driver successfully loads GBase JDBC class
- [ ] Database connection established successfully
- [ ] Timezone set query executes correctly
- [ ] Basic SELECT queries work
- [ ] Parameterized queries work correctly
- [ ] Connection pool functions properly
- [ ] Error handling works as expected

### Test Environment

```bash
CUBEJS_DB_HOST=192.168.3.147
CUBEJS_DB_PORT=5050
CUBEJS_DB_NAME=cube_test
CUBEJS_DB_USER=root
CUBEJS_DB_PASS=gbase123
```

## Documentation Updates

### 1. README.md

- Add GBase to supported databases list
- Add basic configuration example
- Add link to detailed GBASE.md documentation

### 2. GBASE.md (New File)

Create comprehensive documentation including:
- GBase 8a introduction
- JDBC driver installation steps
- Maven repository configuration
- Environment variable reference
- Connection troubleshooting
- Cluster connection notes
- Usage examples

## Files to Modify

1. `src/supported-drivers.ts` - Add gbase configuration (~15 lines)
2. `README.md` - Add GBase support section (~30 lines)
3. `GBASE.md` - Create detailed documentation (~100 lines)

## Implementation Steps

1. ✅ Design review and approval
2. Modify `src/supported-drivers.ts` to add gbase configuration
3. Update README.md with GBase support
4. Create GBASE.md with detailed documentation
5. Test connection to GBase cluster
6. Verify query execution
7. Commit changes

## Future Considerations

- Monitor for GBase-specific SQL dialect differences
- Add GBase-specific optimizations if needed
- Consider adding connection load balancing for cluster nodes
- Evaluate need for GBase-specific type conversions

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| GBase SQL dialect differences | Start with MySQL-compatible approach, adjust as needed |
| Maven dependency resolution issues | Provide local JAR file fallback option |
| Connection pool stability | Use proven generic-pool configuration from other drivers |
| Private repository access | Document authentication requirements clearly |

## Success Criteria

- GBase driver can be instantiated without errors
- Successfully connects to GBase test cluster
- Executes basic queries correctly
- Handles errors appropriately
- Documentation is clear and complete
