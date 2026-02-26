<p align="center"><a href="https://cube.dev"><img src="https://i.imgur.com/zYHXm4o.png" alt="Cube.js" width="300px"></a></p>

[Website](https://cube.dev) • [Docs](https://cube.dev/docs) • [Blog](https://cube.dev/blog) • [Slack](https://slack.cube.dev) • [Twitter](https://twitter.com/the_cube_dev)

[![npm version](https://badge.fury.io/js/%40cubejs-backend%2Fserver.svg)](https://badge.fury.io/js/%40cubejs-backend%2Fserver)
[![GitHub Actions](https://github.com/cube-js/cube.js/workflows/Build/badge.svg)](https://github.com/cube-js/cube.js/actions?query=workflow%3ABuild+branch%3Amaster)

# Cube.js JDBC Database Driver

JDBC driver.

## Supported Databases

This JDBC driver supports the following databases:

- **MySQL** - Production-ready
- **Amazon Athena** - Production-ready
- **Apache Spark SQL** - Production-ready
- **Apache Hive** - Production-ready
- **GBase 8a** - Community supported

## Support

This package is **community supported** and should be used at your own risk.

While the Cube Dev team is happy to review and accept future community contributions, we don't have active plans for
further development. This includes bug fixes unless they affect different parts of Cube.js. **We're looking for
maintainers for this package.** If you'd like to become a maintainer, please contact us in Cube.js Slack.

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

**Note:** When using GBase with Cube.js server, you should also set `externalDbType: 'mysql'` in your cube.js configuration since GBase 8a uses MySQL-compatible SQL syntax:

```javascript
module.exports = {
  dialectFactory: () => {
    return new JDBCDriver({
      dataSource: 'gbase',
      dbType: 'gbase'
    });
  },
  externalDbType: 'mysql' // Use MySQL dialect for SQL generation
};
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

## Java installation

### macOS

```sh
brew install openjdk
# At the moment of writing, openjdk 22.0.1 is the latest and proven to work on Intel/M1 Mac's
# Follow the brew suggested advice at the end of installation:
# For the system Java wrappers to find this JDK, symlink it with
sudo ln -sfn /usr/local/opt/openjdk/libexec/openjdk.jdk /Library/Java/JavaVirtualMachines/openjdk.jdk

# Ensure that newly installed jdk is visible
/usr/libexec/java_home -V
# You should see installed jdk among others, something like this:
Matching Java Virtual Machines (3):
    22.0.1 (x86_64) "Homebrew" - "OpenJDK 22.0.1" /usr/local/Cellar/openjdk/22.0.1/libexec/openjdk.jdk/Contents/Home
    1.8.0_40 (x86_64) "Oracle Corporation" - "Java SE 8" /Library/Java/JavaVirtualMachines/jdk1.8.0_40.jdk/Contents/Home

# Set JAVA_HOME environment variable before running yarn in the Cube repo
export JAVA_HOME=`/usr/libexec/java_home -v 22.0.1`
```

**Note:** It's important to set `JAVA_HOME` prior to running `yarn/npm install` in Cube repo as Java Bridge npm package
uses is to locate JAVA and caches it internally. In case you already run package installation you have to rebuild
all native packages or just delete `node_modules` and run `yarn` again.

### Debian, Ubuntu, etc.

```sh
sudo apt install openjdk-8-jdk
```

### Fedora, Oracle Linux, Red Hat Enterprise Linux, etc.

```sh
su -c "yum install java-1.8.0-openjdk"
```

### Windows

If you have Chocolatey packet manager:

```
choco install openjdk
```

## License

Cube.js JDBC Database Driver is [Apache 2.0 licensed](./LICENSE).
