/**
 * @copyright Cube Dev, Inc.
 * @license Apache-2.0
 * @fileoverview The `GaussDBDriver` and related types declaration.
 */

import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { promisify } from 'util';
import { getEnv, CancelablePromise } from '@cubejs-backend/shared';
import {
  JDBCDriver,
  JDBCDriverConfiguration,
} from '@cubejs-backend/jdbc-driver';
import {
  DownloadQueryResultsOptions,
  DownloadQueryResultsResult,
  DownloadStreamTableData,
  Row,
  StreamOptions,
  TableStructure,
} from '@cubejs-backend/base-driver';

// Use the same Java bridge as the parent JDBCDriver.
// eslint-disable-next-line import/no-extraneous-dependencies
const jinst = require('@cubejs-backend/jdbc/lib/jinst');

export type GaussDBDriverConfiguration = Partial<JDBCDriverConfiguration> & {
  host?: string;
  port?: number | string;
  user?: string;
  password?: string;
  schema?: string;
  dataSource?: string;
  preAggregations?: boolean;
  maxPoolSize?: number;
  testConnectionTimeout?: number;
  executionTimeout?: number;
  readOnly?: boolean;
};

type QueryState = {
  connection?: any;
  statement?: any;
  resultSet?: any;
  cancelled?: boolean;
  broken?: boolean;
  cleanup?: Promise<void>;
};

type ResultColumn = {
  name: string;
  nativeType: string;
  jdbcType: number;
  precision: number;
  scale: number;
};

const call = (object: any, method: string, ...args: any[]): Promise<any> => (
  promisify(object[method].bind(object))(...args)
);

/** GaussDB 507 centralized PG mode, using the customer-supplied gsjdbc200.jar. */
export class GaussDBDriver extends JDBCDriver {
  private readonly gaussConfig: GaussDBDriverConfiguration;

  private readonly initializedConnections = new WeakSet<object>();

  public constructor(
    config: GaussDBDriverConfiguration = {}
  ) {
    const dataSource = config.dataSource || 'default';
    const envOptions = { dataSource, preAggregations: config.preAggregations || false };
    const host = config.host || getEnv('dbHost', envOptions);
    const port = config.port || getEnv('dbPort', envOptions);
    const database = config.database || getEnv('dbName', envOptions);
    const url = config.url || getEnv('jdbcUrl', envOptions) || (
      host && port && database ? `jdbc:gaussdb://${host}:${port}/${database}` : undefined
    );
    if (!url || !url.startsWith('jdbc:gaussdb://')) {
      throw new Error('GaussDB requires a jdbc:gaussdb:// URL or explicit host, port and database');
    }
    if (config.drivername && config.drivername !== 'com.huawei.gauss200.jdbc.Driver') {
      throw new Error('GaussDB requires com.huawei.gauss200.jdbc.Driver from gsjdbc200.jar');
    }
    super({
      ...config,
      dbType: 'gaussdb',
      database,
      url,
      drivername: 'com.huawei.gauss200.jdbc.Driver',
      properties: Object.fromEntries(
        Object.entries({
          user: config.user ?? getEnv('dbUser', envOptions),
          password: config.password ?? getEnv('dbPass', envOptions),
          ...config.properties,
        })
          .filter(([, value]) => value != null)
          .map(([key, value]) => [key, String(value)])
      ),
    });
    this.gaussConfig = config;
  }

  protected async getCustomClassPath(): Promise<string[]> {
    const directory = path.resolve(process.env.CUBEJS_JDBC_CUSTOM_CLASSPATH || 'drivers');
    const jar = path.join(directory, 'gsjdbc200.jar');
    if (!fs.existsSync(jar) || !fs.statSync(jar).isFile()) {
      throw new Error(`GaussDB JDBC driver missing: ${jar}; set CUBEJS_JDBC_CUSTOM_CLASSPATH=drivers`);
    }
    return fs.readdirSync(directory)
      .filter((file) => file.toLowerCase().endsWith('.jar'))
      .sort()
      .map((file) => path.join(directory, file));
  }

  protected async initializeSession(connection: any): Promise<void> {
    const queries = ['SET TIME ZONE \'UTC\''];
    if (this.gaussConfig.schema) {
      queries.push(`SET search_path TO ${this.quoteIdentifier(this.gaussConfig.schema)}`);
    }
    for (const sql of queries) {
      const statement = await call(connection, 'createStatement');
      try {
        await call(statement, 'execute', sql);
      } finally {
        await call(statement, 'close');
      }
    }
  }

  protected async bindParameters(statement: any, values: unknown[]): Promise<void> {
    const java = jinst.getInstance();
    for (let offset = 0; offset < values.length; offset++) {
      const index = offset + 1;
      const value = values[offset];
      if (value == null) {
        await call(statement._ps, 'setNull', index, 0); // java.sql.Types.NULL
      } else if (typeof value === 'boolean') {
        await call(statement, 'setBoolean', index, value);
      } else if (typeof value === 'number' && Number.isFinite(value)) {
        if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
          throw new Error('Unsafe integer parameter: pass bigint or an exact decimal string');
        }
        await call(statement, 'setBigDecimal', index, java.newInstanceSync('java.math.BigDecimal', String(value)));
      } else if (typeof value === 'bigint') {
        await call(statement, 'setBigDecimal', index, java.newInstanceSync('java.math.BigDecimal', String(value)));
      } else if (value instanceof Date && Number.isFinite(value.getTime())) {
        const timezone = java.callStaticMethodSync('java.util.TimeZone', 'getTimeZone', 'UTC');
        const calendar = java.callStaticMethodSync('java.util.Calendar', 'getInstance', timezone);
        await call(
          statement,
          'setTimestamp',
          index,
          java.newInstanceSync('java.sql.Timestamp', java.newLong(value.getTime())),
          calendar
        );
      } else if (Buffer.isBuffer(value)) {
        const bytes = Array.from(value, (byte) => (byte > 127 ? byte - 256 : byte));
        await call(statement, 'setBytes', index, java.newArray('byte', bytes));
      } else if (typeof value === 'string') {
        // Let GaussDB infer the target SQL type of string-valued Cube filters.
        await call(statement._ps, 'setObject', index, value, 1111); // Types.OTHER
      } else {
        throw new Error(`Unsupported GaussDB parameter type: ${typeof value}`);
      }
    }
  }

  private async open(sql: string, values: unknown[], state: QueryState): Promise<void> {
    state.connection = await this.pool.acquire();
    if (state.cancelled) {
      throw new Error('GaussDB query cancelled');
    }
    if (!this.initializedConnections.has(state.connection)) {
      try {
        await this.initializeSession(state.connection);
        this.initializedConnections.add(state.connection);
      } catch (error) {
        // A partially initialized session must never return to the pool.
        state.broken = true;
        throw error;
      }
    }
    state.statement = await call(state.connection, 'prepareStatement', sql);
    await call(state.statement, 'setQueryTimeout', this.gaussConfig.executionTimeout ?? 600);
    await this.bindParameters(state.statement, values);
    if (state.cancelled) {
      throw new Error('GaussDB query cancelled');
    }
    if (await call(state.statement, 'execute')) {
      // The generic JDBC ResultSet wrapper converts BigDecimal to Double.
      state.resultSet = await call(state.statement._ps, 'getResultSet');
    }
  }

  private async columns(resultSet: any): Promise<ResultColumn[]> {
    const metadata = await call(resultSet, 'getMetaData');
    const count = await call(metadata, 'getColumnCount');
    const columns: ResultColumn[] = [];
    for (let index = 1; index <= count; index++) {
      columns.push({
        name: await call(metadata, 'getColumnLabel', index),
        nativeType: (await call(metadata, 'getColumnTypeName', index)).toLowerCase(),
        jdbcType: await call(metadata, 'getColumnType', index),
        precision: await call(metadata, 'getPrecision', index),
        scale: await call(metadata, 'getScale', index),
      });
    }
    return columns;
  }

  private async row(resultSet: any, columns: ResultColumn[]): Promise<Row> {
    const entries: [string, unknown][] = [];
    for (let offset = 0; offset < columns.length; offset++) {
      const column = columns[offset];
      const index = offset + 1;
      let value: unknown = await call(resultSet, 'getString', index);
      if (value !== null) {
        if ([-7, 16].includes(column.jdbcType)) {
          value = await call(resultSet, 'getBoolean', index);
        } else if ([-6, 5, 4, 6, 7, 8].includes(column.jdbcType)) {
          value = Number(value);
        } else if ([-2, -3, -4, 2004].includes(column.jdbcType)) {
          value = Buffer.from(await call(resultSet, 'getBytes', index)).toString('base64');
        } else if (column.jdbcType === 91) {
          value = `${value}T00:00:00.000`;
        } else if (column.jdbcType === 2014 || ['timestamptz', 'timestamp with time zone'].includes(column.nativeType)) {
          value = new Date(String(value)).toISOString().slice(0, -1);
        } else if (column.jdbcType === 93) {
          const text = String(value);
          value = `${text.slice(0, 10)}T${text.slice(11, 19)}.${`${text.slice(20, 23)}00`.slice(0, 3)}`;
        }
      }
      entries.push([column.name, value]);
    }
    return Object.fromEntries(entries);
  }

  private markBroken(state: QueryState, error: any): void {
    const sqlState = error?.cause?.getSQLStateSync?.() || error?.sqlState;
    state.broken = state.broken || (typeof sqlState === 'string' && sqlState.startsWith('08'));
  }

  private close(state: QueryState): Promise<void> {
    if (!state.cleanup) {
      state.cleanup = (async () => {
        let closeError;
        for (const resource of [state.resultSet, state.statement]) {
          if (resource) {
            try {
              await call(resource, 'close');
            } catch (error) {
              closeError = error;
            }
          }
        }
        if (state.connection) {
          if (state.broken || closeError) {
            await this.pool.destroy(state.connection);
          } else {
            await this.pool.release(state.connection);
          }
        }
        if (closeError) {
          throw closeError;
        }
      })();
    }
    return state.cleanup;
  }

  public query<R = unknown>(sql: string, values: unknown[] = []): Promise<R[]> {
    const state: QueryState = {};
    const promise = (async () => {
      try {
        await this.open(sql, values, state);
        if (!state.resultSet) {
          return [];
        }
        const columns = await this.columns(state.resultSet);
        const rows: R[] = [];
        while (await call(state.resultSet, 'next')) {
          if (state.cancelled) {
            throw new Error('GaussDB query cancelled');
          }
          rows.push(await this.row(state.resultSet, columns) as R);
        }
        if (state.cancelled) {
          throw new Error('GaussDB query cancelled');
        }
        return rows;
      } catch (error) {
        this.markBroken(state, error);
        throw error;
      } finally {
        await this.close(state);
      }
    })() as CancelablePromise<R[]>;
    promise.cancel = async () => {
      state.cancelled = true;
      if (state.statement) {
        await call(state.statement, 'cancel');
      }
    };
    return promise;
  }

  public async stream(
    sql: string,
    values: unknown[],
    options: StreamOptions
  ): Promise<DownloadStreamTableData> {
    const state: QueryState = {};
    try {
      await this.open(sql, values, state);
      if (!state.resultSet) {
        throw new Error('GaussDB streaming query must return a result set');
      }
      const columns = await this.columns(state.resultSet);
      const types = columns.map((column) => ({
        name: column.name,
        type: this.toGenericType(column.nativeType, column.precision, column.scale),
      }));
      const driver = this;
      const rowStream = Readable.from((async function* rows() {
        try {
          while (await call(state.resultSet, 'next')) {
            yield await driver.row(state.resultSet, columns);
          }
        } catch (error) {
          driver.markBroken(state, error);
          throw error;
        } finally {
          await driver.close(state);
        }
      }()), { objectMode: true, highWaterMark: options.highWaterMark });
      // Also release a stream destroyed before its iterator starts.
      rowStream.once('close', () => {
        this.close(state).catch((error) => this.databasePoolError(error));
      });
      return {
        rowStream,
        types,
        release: async () => {
          if (!rowStream.closed) {
            // Wait for any pending JDBC read before closing its resources.
            const closed = new Promise<void>((resolve) => rowStream.once('close', resolve));
            rowStream.destroy();
            await closed;
          }
          await this.close(state);
        },
      };
    } catch (error) {
      this.markBroken(state, error);
      await this.close(state);
      throw error;
    }
  }

  public async downloadQueryResults(
    sql: string,
    values: unknown[],
    options: DownloadQueryResultsOptions
  ): Promise<DownloadQueryResultsResult> {
    const result = await this.stream(sql, values, options);
    if (options.streamImport) {
      return result;
    }
    try {
      const rows: Row[] = [];
      for await (const row of result.rowStream as Readable) {
        rows.push(row);
      }
      return { rows, types: result.types };
    } finally {
      await result.release?.();
    }
  }

  public readOnly(): boolean {
    return this.gaussConfig.readOnly ?? true;
  }

  protected toGenericType(
    columnType: string,
    precision?: number | null,
    scale?: number | null
  ): string {
    if (['timestamptz', 'timestamp with time zone'].includes(columnType)) {
      return 'timestamp';
    }
    const genericType = super.toGenericType(columnType);
    if (genericType === 'decimal' && precision && scale != null && getEnv('preciseDecimalInCubestore')) {
      return `decimal(${precision}, ${scale})`;
    }
    return genericType;
  }

  protected quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  public async tableColumnTypes(table: string): Promise<TableStructure> {
    const result = await this.stream(`SELECT * FROM ${table} WHERE 1 = 0`, [], { highWaterMark: 16 });
    try {
      return result.types;
    } finally {
      await result.release?.();
    }
  }

  public async testConnection(): Promise<void> {
    await this.query('SELECT ?::int AS number', [1]);
  }
}
