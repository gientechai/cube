/**
 * @copyright Cube Dev, Inc.
 * @license Apache-2.0
 * @fileoverview The `JDBCDriver` and related types declaration.
 */

import {
  getEnv,
  assertDataSource,
  CancelablePromise,
  Pool,
} from '@cubejs-backend/shared';
import {
  BaseDriver,
  createPoolName,
  DownloadQueryResultsOptions,
  DownloadQueryResultsResult,
  StreamOptions,
} from '@cubejs-backend/base-driver';
import * as SqlString from 'sqlstring';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';

import { SupportedDrivers } from './supported-drivers';
import type { DriverOptionsInterface } from './supported-drivers';
import type { JDBCDriverConfiguration } from './types';
import { QueryStream, transformRow } from './QueryStream';
import type { nextFn } from './QueryStream';

/* eslint-disable no-restricted-syntax,import/no-extraneous-dependencies */
const DriverManager = require('@cubejs-backend/jdbc/lib/drivermanager');
const Connection = require('@cubejs-backend/jdbc/lib/connection');
const DatabaseMetaData = require('@cubejs-backend/jdbc/lib/databasemetadata');
const jinst = require('@cubejs-backend/jdbc/lib/jinst');
const mvn = require('@cubejs-backend/node-java-maven');

let mvnPromise: Promise<void> | null = null;
let kerberosLoginPromise: Promise<void> | null = null;
let kerberosLoginKey: string | null = null;

function normalizeClassPath(customClassPath: any): string[] {
  if (!customClassPath) {
    return [];
  }
  return Array.isArray(customClassPath) ? customClassPath : [customClassPath];
}

function jarsFromDir(dir: string | undefined): string[] {
  if (!dir) {
    return [];
  }
  try {
    const resolved = path.resolve(dir);
    return fs.readdirSync(resolved)
      .filter((file) => file.toLowerCase().endsWith('.jar'))
      .sort()
      .map((file) => path.join(resolved, file));
  } catch (e) {
    return [];
  }
}

/**
 * The JVM can only be created with one classpath. Collect the configured
 * GBase/Hive directories on the first JDBC initialization so a later Hive
 * source is not missing its jars when GBase happened to initialize the JVM first.
 */
function configuredClassPath(): string[] {
  return [process.env.CUBEJS_JDBC_CUSTOM_CLASSPATH]
    .flatMap((dir) => jarsFromDir(dir));
}

function addJvmOptionsFromEnv() {
  const raw = process.env.CUBEJS_JDBC_JVM_OPTIONS || '';
  raw
    .split(/\s+/)
    .map((option) => option.trim())
    .filter(Boolean)
    .forEach((option) => jinst.addOption(option));
}

const initMvn = (customClassPath: any) => {
  if (!mvnPromise) {
    mvnPromise = new Promise((resolve, reject) => {
      const setupJvm = (mvnResults: any) => {
        if (!jinst.isJvmCreated()) {
          jinst.addOption('-Xrs');
          jinst.addOption('-Dfile.encoding=UTF8');

          // Workaround for Databricks JDBC driver
          // Issue when deserializing Apache Arrow data with Java JVMs version 11 or higher, due to compatibility issues.
          jinst.addOption('--add-opens=java.base/java.nio=ALL-UNNAMED');

          // Java 17 needs --add-exports for Hadoop KerberosUtil.
          // Keep these in CUBEJS_JDBC_JVM_OPTIONS so JDK 8 deployments are not broken.
          addJvmOptionsFromEnv();

          const classPath = (mvnResults && mvnResults.classpath || [])
            .concat(configuredClassPath(), normalizeClassPath(customClassPath));
          jinst.setupClasspath(Array.from(new Set(classPath)));
        }
        resolve();
      };

      if (process.env.CUBEJS_JDBC_DISABLE_MVN === 'true') {
        setupJvm(null);
        return;
      }

      const options = {
        packageJsonPath: `${path.join(__dirname, '../..')}/package.json`,
      };
      mvn(options, (err: any, mvnResults: any) => {
        if (err && !err.message.includes('Could not find java property')) {
          reject(err);
        } else {
          setupJvm(mvnResults);
        }
      });
    });
  }
  return mvnPromise;
};

/**
 * Initialize Hadoop UGI from the same krb5.conf/keytab that the Java source stores.
 * UGI is process-global, so a second Hive source with a different principal/keytab
 * must currently be isolated in a separate Cube process.
 */
const ensureKerberos = (config: JDBCDriverConfiguration): Promise<void> => {
  if (!config.enableKerberos) {
    return Promise.resolve();
  }

  const { principal, keytabPath, krb5ConfPath } = config;
  if (!principal || !keytabPath || !krb5ConfPath) {
    return Promise.reject(new Error(
      'Hive Kerberos requires principal, keytabPath and krb5ConfPath in the JDBC driver config'
    ));
  }

  const loginKey = `${principal}|${keytabPath}|${krb5ConfPath}`;
  if (kerberosLoginPromise) {
    if (kerberosLoginKey !== loginKey) {
      return Promise.reject(new Error(
        `Kerberos is already initialized for ${kerberosLoginKey}; ` +
        `cannot switch to ${loginKey} in the same JVM. Use a separate Cube process per Kerberos identity.`
      ));
    }
    return kerberosLoginPromise;
  }

  kerberosLoginKey = loginKey;
  kerberosLoginPromise = Promise.resolve().then(() => {
    const java = jinst.getInstance();

    // node-java invokes Java on a JNI-created thread. Ensure Hadoop's resource
    // lookup sees the JVM system classloader instead of that thread's empty TCCL.
    const currentThread = java.callStaticMethodSync('java.lang.Thread', 'currentThread');
    const systemClassLoader = java.callStaticMethodSync('java.lang.ClassLoader', 'getSystemClassLoader');
    java.callMethodSync(currentThread, 'setContextClassLoader', systemClassLoader);

    java.callStaticMethodSync('java.lang.System', 'setProperty', 'java.security.krb5.conf', krb5ConfPath);

    const Configuration = java.import('org.apache.hadoop.conf.Configuration');
    const conf = new Configuration();
    java.callMethodSync(conf, 'set', 'hadoop.security.authentication', 'kerberos');

    java.callStaticMethodSync(
      'org.apache.hadoop.security.UserGroupInformation',
      'setConfiguration',
      conf
    );
    java.callStaticMethodSync(
      'org.apache.hadoop.security.UserGroupInformation',
      'loginUserFromKeytab',
      principal,
      keytabPath
    );

    // Optional TGT renewal. Disabled by default; set the interval to e.g. 1800000 for long-running services.
    const reloginInterval = Number(process.env.CUBEJS_JDBC_KERBEROS_RELOGIN_MS || 0);
    if (reloginInterval > 0) {
      try {
        const ugi = java.callStaticMethodSync(
          'org.apache.hadoop.security.UserGroupInformation',
          'getLoginUser'
        );
        const timer = setInterval(() => {
          try {
            ugi.checkTGTAndReloginFromKeytabSync();
          } catch (e) {
            // Keep the service alive; the next query will surface the authentication error.
          }
        }, reloginInterval);
        if (typeof timer.unref === 'function') {
          timer.unref();
        }
      } catch (e) {
        // Older node-java/Hadoop combinations may not expose the sync method; renewal stays external.
      }
    }
  }).catch((e) => {
    // Allow a later retry if the keytab/KDC was temporarily unavailable.
    kerberosLoginPromise = null;
    kerberosLoginKey = null;
    throw e;
  });

  return kerberosLoginPromise;
};

const applyParams = (query: string, params: object | any[]) => SqlString.format(query, params);

// promisify Connection methods
Connection.prototype.getMetaDataAsync = promisify(Connection.prototype.getMetaData);
// promisify DatabaseMetaData methods
DatabaseMetaData.prototype.getSchemasAsync = promisify(DatabaseMetaData.prototype.getSchemas);
DatabaseMetaData.prototype.getTablesAsync = promisify(DatabaseMetaData.prototype.getTables);

export class JDBCDriver extends BaseDriver {
  protected readonly config: JDBCDriverConfiguration;

  protected pool: Pool<any>;

  protected jdbcProps: any;

  // GBase timezone cache to avoid repeated SHOW VARIABLES queries
  private gbaseTimezoneCache: string = '+00:00';

  public constructor(
    config: Partial<JDBCDriverConfiguration> & {
      /**
       * Data source name.
       */
      dataSource?: string,

      /**
       * Whether this driver is used for pre-aggregations.
       */
      preAggregations?: boolean,

      /**
       * Max pool size value for the [cube]<-->[db] pool.
       */
      maxPoolSize?: number,

      /**
       * Time to wait for a response from a connection after validation
       * request before determining it as not valid. Default - 60000 ms.
       */
      testConnectionTimeout?: number,
    } = {}
  ) {
    super({
      testConnectionTimeout: config.testConnectionTimeout || 60000,
    });

    const dataSource =
      config.dataSource ||
      assertDataSource('default');
    const preAggregations = config.preAggregations || false;

    const { poolOptions, ...dbOptions } = config;

    const dbTypeDescription = JDBCDriver.dbTypeDescription(
      <string>(config.dbType || getEnv('dbType', { dataSource, preAggregations })),
    );

    this.config = {
      dbType: getEnv('dbType', { dataSource, preAggregations }),
      url:
        getEnv('jdbcUrl', { dataSource, preAggregations }) ||
        dbTypeDescription && dbTypeDescription.jdbcUrl(),
      drivername:
        getEnv('jdbcDriver', { dataSource, preAggregations }) ||
        dbTypeDescription && dbTypeDescription.driverClass,
      properties: dbTypeDescription && dbTypeDescription.properties,
      ...dbOptions
    } as JDBCDriverConfiguration;

    if (!this.config.drivername) {
      throw new Error('drivername is required property');
    }

    if (!this.config.url) {
      throw new Error('url is required property');
    }

    const poolName = createPoolName('jdbc', dataSource, preAggregations);
    this.pool = new Pool(poolName, {
      create: async () => {
        await initMvn(await this.getCustomClassPath());
        await ensureKerberos(this.config);

        if (!this.jdbcProps) {
          /** @protected */
          this.jdbcProps = this.getJdbcProperties();
        }

        const getConnection = promisify(DriverManager.getConnection.bind(DriverManager));
        return new Connection(await getConnection(this.config.url, this.jdbcProps));
      },
      destroy: async (connection) => promisify(connection.close.bind(connection))(),
      validate: async (connection) => (
        new Promise((resolve) => {
          const isValid = promisify(connection.isValid.bind(connection));
          const timeout = setTimeout(() => {
            if (this.logger) {
              this.logger('Connection validation failed by timeout', {
                testConnectionTimeout: this.testConnectionTimeout(),
              });
            }
            resolve(false);
          }, this.testConnectionTimeout());
          isValid(0).then((valid: boolean) => {
            clearTimeout(timeout);
            if (!valid && this.logger) {
              this.logger('Connection validation failed', {});
            }
            resolve(valid);
          }).catch((e: { stack?: string }) => {
            clearTimeout(timeout);
            this.databasePoolError(e);
            resolve(false);
          });
        })
      )
    }, {
      min: 0,
      max: config.maxPoolSize || getEnv('dbMaxPoolSize', { dataSource, preAggregations }) || 8,
      evictionRunIntervalMillis: 10000,
      softIdleTimeoutMillis: 30000,
      idleTimeoutMillis: 30000,
      testOnBorrow: true,
      acquireTimeoutMillis: 120000,
      ...(poolOptions || {})
    });

    // https://github.com/coopernurse/node-pool/blob/ee5db9ddb54ce3a142fde3500116b393d4f2f755/README.md#L220-L226
    this.pool.on('factoryCreateError', (err) => {
      this.databasePoolError(err);
    });
    this.pool.on('factoryDestroyError', (err) => {
      this.databasePoolError(err);
    });
  }

  protected async getCustomClassPath() {
    return this.config.customClassPath;
  }

  protected getJdbcProperties() {
    const java = jinst.getInstance();
    const Properties = java.import('java.util.Properties');
    const properties = new Properties();

    for (const [name, value] of Object.entries(this.config.properties || {})) {
      properties.putSync(name, value);
    }

    return properties;
  }

  public async testConnection() {
    let err;
    let connection;

    try {
      connection = await this.pool._factory.create();
    } catch (e: any) {
      err = e.message || e;
    }

    if (err) {
      throw new Error(err.toString());
    } else {
      await this.pool._factory.destroy(connection);
    }
  }

  protected prepareConnectionQueries() {
    const dbTypeDescription = JDBCDriver.dbTypeDescription(this.config.dbType);
    return this.config.prepareConnectionQueries ||
      dbTypeDescription && dbTypeDescription.prepareConnectionQueries ||
      [];
  }

  /**
   * Get GBase session timezone dynamically
   * Caches the result to avoid repeated queries
   * Uses raw connection to avoid circular dependency
   */
  protected async getGBaseTimezone(): Promise<string> {
    // Return cached value if available
    if (this.gbaseTimezoneCache) {
      return this.gbaseTimezoneCache;
    }

    try {
      // Get a connection from the pool
      const conn = await this.pool.acquire();

      try {
        // Create statement and execute query
        const createStatementAsync = promisify(conn.createStatement.bind(conn));
        const statement = await createStatementAsync();

        // Use SHOW VARIABLES LIKE 'time_zone' (not SHOW VARIABLE)
        // This returns time_zone only, not system_time_zone
        const executeQueryAsync = promisify(statement.execute.bind(statement));
        const resultSet = await executeQueryAsync("SHOW VARIABLES LIKE 'time_zone'");

        // Get result
        const toObjArrayAsync = promisify(resultSet.toObjArray.bind(resultSet));
        const result: any[] = await toObjArrayAsync();

        // Close result
        const closeAsync = promisify(resultSet.close.bind(resultSet));
        await closeAsync();

        // Extract timezone value (result array format: [{Variable_name: 'time_zone', Value: '+08:00'}])
        if (result && result.length > 0 && result[0].Value) {
          this.gbaseTimezoneCache = result[0].Value;
          return this.gbaseTimezoneCache;
        }
      } finally {
        // Release connection back to pool
        await this.pool.release(conn);
      }
    } catch (error: any) {
      // If query fails, log warning and fallback to UTC
      console.warn('[JDBCDriver] Failed to query GBase timezone, using UTC fallback:', error.message);
    }

    // Fallback to UTC if query fails
    this.gbaseTimezoneCache = '+00:00';
    return this.gbaseTimezoneCache;
  }

  public async query<R = unknown>(query: string, values: unknown[]): Promise<R[]> {
    let queryWithParams = applyParams(query, values);

    // GBase: Replace @@session.time_zone with actual session timezone
    // GBase JDBC driver incorrectly converts @@session.time_zone to get_system_var()
    const gbaseTimezonePattern = /@@session\.time_zone/gi;
    if ((this.config.dbType === 'gbase' || (this.config.url && this.config.url.startsWith('jdbc:gbase:')))
        && gbaseTimezonePattern.test(queryWithParams)) {
      const gbaseTimezone = await this.getGBaseTimezone();
      queryWithParams = queryWithParams.replace(gbaseTimezonePattern, `'${gbaseTimezone || '+00:00'}'`);
    }

    const cancelObj: {cancel?: Function} = {};
    const promise = this.queryPromised(queryWithParams, cancelObj, this.prepareConnectionQueries());
    (promise as CancelablePromise<any>).cancel =
      () => cancelObj.cancel && cancelObj.cancel() ||
      Promise.reject(new Error('Statement is not ready'));
    return promise;
  }

  protected async withConnection<T extends Function>(fn: T) {
    const conn = await this.pool.acquire();

    try {
      return await fn(conn);
    } finally {
      await this.pool.release(conn);
    }
  }

  protected async queryPromised(query: string, cancelObj: any, options: any) {
    options = options || {};

    try {
      const conn = await this.pool.acquire();
      try {
        const prepareConnectionQueries = options.prepareConnectionQueries || [];
        for (let i = 0; i < prepareConnectionQueries.length; i++) {
          await this.executeStatement(conn, prepareConnectionQueries[i]);
        }
        return await this.executeStatement(conn, query, cancelObj);
      } finally {
        await this.pool.release(conn);
      }
    } catch (ex: any) {
      if (ex.cause) {
        throw new Error(ex.cause.getMessageSync());
      } else {
        throw ex;
      }
    }
  }

  public async stream(sql: string, values: unknown[], { highWaterMark }: StreamOptions): Promise<DownloadQueryResultsResult> {
    const conn = await this.pool.acquire();
    let query = applyParams(sql, values);

    // GBase: Replace @@session.time_zone with actual session timezone
    // GBase JDBC driver incorrectly converts @@session.time_zone to get_system_var()
    const gbaseTimezonePattern = /@@session\.time_zone/gi;
    if ((this.config.dbType === 'gbase' || (this.config.url && this.config.url.startsWith('jdbc:gbase:')))
        && gbaseTimezonePattern.test(query)) {
      const gbaseTimezone = await this.getGBaseTimezone();
      query = query.replace(gbaseTimezonePattern, `'${gbaseTimezone || '+00:00'}'`);
    }

    const cancelObj: {cancel?: Function} = {};
    try {
      const createStatement = promisify(conn.createStatement.bind(conn));
      const statement = await createStatement();

      if (cancelObj) {
        cancelObj.cancel = promisify(statement.cancel.bind(statement));
      }

      const executeQuery = promisify(statement.execute.bind(statement));
      const resultSet = await executeQuery(query);
      return (await new Promise((resolve, reject) => {
        resultSet.toObjectIter(
          (
            err: unknown,
            res: {
                labels: string[],
                types: number[],
                rows: { next: nextFn },
              },
          ) => {
            if (err) {
              reject(err);
              return;
            }

            const rowStream = new QueryStream(res.rows.next, highWaterMark);
            resolve({
              rowStream,
              release: () => this.pool.release(conn),
              types: res.types.map(
                (t, i) => ({
                  name: res.labels[i],
                  type: this.toGenericType(((t === -5 ? 'bigint' : resultSet._types[t]) || 'string').toLowerCase())
                })
              )
            });
          }
        );
      }));
    } catch (ex: any) {
      await this.pool.release(conn);
      if (ex.cause) {
        throw new Error(ex.cause.getMessageSync());
      } else {
        throw ex;
      }
    }
  }

  public async downloadQueryResults(query: string, values: unknown[], options: DownloadQueryResultsOptions): Promise<DownloadQueryResultsResult> {
    if (options.streamImport) {
      return this.stream(query, values, options);
    }

    return super.downloadQueryResults(query, values, options);
  }

  protected async executeStatement(conn: any, query: any, cancelObj?: any) {
    const createStatementAsync = promisify(conn.createStatement.bind(conn));
    const statement = await createStatementAsync();
    if (cancelObj) {
      cancelObj.cancel = promisify(statement.cancel.bind(statement));
    }
    const setQueryTimeout = promisify(statement.setQueryTimeout.bind(statement));
    await setQueryTimeout(600);
    const executeQueryAsync = promisify(statement.execute.bind(statement));
    const resultSet = await executeQueryAsync(query);

    if (resultSet.toObjArray) {
      const result: any = await (promisify(resultSet.toObjArray.bind(resultSet)))();

      for (const [key, row] of Object.entries(result)) {
        result[key] = transformRow(row);
      }

      return result;
    }

    return resultSet;
  }

  public async release() {
    await this.pool.drain();
    await this.pool.clear();
  }

  public static getSupportedDrivers(): string[] {
    return Object.keys(SupportedDrivers);
  }

  public static dbTypeDescription(dbType: string): DriverOptionsInterface {
    return SupportedDrivers[dbType];
  }
}
