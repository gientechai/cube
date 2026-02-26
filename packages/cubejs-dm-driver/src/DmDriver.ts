/**
 * DM (Dameng) driver based on official `dmdb` Node.js client.
 */
import { getEnv, assertDataSource } from "@cubejs-backend/shared";
import {
  BaseDriver,
  DriverInterface,
  StreamOptions,
  DownloadQueryResultsOptions,
  DownloadQueryResultsResult,
  TableStructure,
  DriverCapabilities,
  TableColumnQueryResult,
  GenericDataBaseType,
  QueryOptions,
} from "@cubejs-backend/base-driver";
import type { TableQueryResult } from "@cubejs-backend/base-driver/dist/src/driver.interface";
import dmdb from "dmdb";

export type DmDriverConfiguration = {
  /**
   * Marks driver as read-only (used by Cube for some optimizations).
   */
  readOnly?: boolean;

  /**
   * Native DM connection string.
   * Example: dm://SYSDBA:sysDBA*00@localhost:5236?schema=SYSDBA
   */
  connectString?: string;

  /**
   * DM pool options (see official docs).
   */
  poolMin?: number;
  poolMax?: number;

  // Allow additional dmdb-specific options to be passed through.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
};

const GenericTypeToDm: Record<GenericDataBaseType, string> = {
  boolean: "NUMBER(1)",
  string: "VARCHAR(255)",
  text: "VARCHAR(255)",
  int: "INTEGER",
  bigint: "BIGINT",
  decimal: "DECIMAL(38,10)",
  double: "DOUBLE",
  time: "TIME",
  date: "DATE",
  timestamp: "TIMESTAMP",
  uuid: "VARCHAR(36)",
};

const DmToGenericType: Record<string, GenericDataBaseType> = {
  boolean: "boolean",
  bit: "boolean",
  number: "decimal",
  numeric: "decimal",
  decimal: "decimal",
  integer: "int",
  int: "int",
  smallint: "int",
  tinyint: "int",
  bigint: "bigint",
  float: "float",
  double: "double",
  real: "double",
  char: "text",
  nchar: "text",
  varchar: "text",
  varchar2: "text",
  nvarchar2: "text",
  clob: "text",
  blob: "string",
  date: "date",
  timestamp: "timestamp",
};

type DmPool = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getConnection: () => Promise<any>;
  close: () => Promise<void>;
};

/**
 * DM driver class.
 */
export class DmDriver extends BaseDriver implements DriverInterface {
  /**
   * Returns default concurrency value.
   */
  public static getDefaultConcurrency(): number {
    return 2;
  }

  /**
   * List of environment variables used by this driver.
   * Note: returned names are unprefixed, Cube will map them to CUBEJS_DB_*.
   */
  public static driverEnvVariables() {
    return [
      "CUBEJS_DB_HOST",
      "CUBEJS_DB_NAME",
      "CUBEJS_DB_PORT",
      "CUBEJS_DB_USER",
      "CUBEJS_DB_PASS",
    ];
  }

  private readonly config: DmDriverConfiguration;

  private poolPromise?: Promise<DmPool>;

  /**
   * Class constructor.
   */
  public constructor(
    config: DmDriverConfiguration & {
      /**
       * Data source name.
       */
      dataSource?: string;

      /**
       * Max pool size value for the [cube]<-->[db] pool.
       */
      maxPoolSize?: number;

      /**
       * Time to wait for a response from a connection after validation
       * request before determining it as not valid. Default - 10000 ms.
       */
      testConnectionTimeout?: number;
    } = {}
  ) {
    super({
      testConnectionTimeout: config.testConnectionTimeout,
    });

    const dataSource = config.dataSource || assertDataSource("default");

    const host = (getEnv as any)("dbHost", { dataSource });
    const port = (getEnv as any)("dbPort", { dataSource });
    const user = (getEnv as any)("dbUser", { dataSource });
    const password = (getEnv as any)("dbPass", { dataSource });
    const dbName = (getEnv as any)("dbName", { dataSource });

    // Default schema: prefer dbName, fall back to user.
    const schema = dbName || user;

    const defaultConnectString =
      host && port && user && password
        ? `dm://${encodeURIComponent(user)}:${encodeURIComponent(
            password
          )}@${host}:${port}?schema=${schema}`
        : undefined;

    this.config = {
      readOnly: true,
      poolMin: 0,
      poolMax:
        config.maxPoolSize ||
        (getEnv as any)("dbMaxPoolSize", { dataSource }) ||
        8,
      connectString: config.connectString || defaultConnectString,
      ...config,
    };

    // Configure global dmdb options where appropriate.
    // Use objects for rows by default to match other drivers.
    // eslint-disable-next-line no-param-reassign
    (dmdb as any).outFormat = (dmdb as any).OUT_FORMAT_OBJECT;
  }

  private async getPool(): Promise<DmPool> {
    if (!this.poolPromise) {
      if (!this.config.connectString) {
        throw new Error("DM driver: connectString is not defined");
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const poolAttrs: any = {
        connectString: this.config.connectString,
        poolMin: this.config.poolMin,
        poolMax: this.config.poolMax,
      };

      // dmdb.createPool returns a Promise<Pool>
      this.poolPromise = (dmdb as any).createPool(poolAttrs);
    }
    return this.poolPromise!;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getConnection(): Promise<any> {
    const pool = await this.getPool();
    return pool.getConnection();
  }

  public async testConnection(): Promise<void> {
    const conn = await this.getConnection();

    try {
      // Simple heartbeat query; DM is compatible with SELECT 1.
      await conn.execute("SELECT 1");
    } finally {
      await conn.close();
    }
  }

  public async query<R = unknown>(
    query: string,
    values: unknown[] = [],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _options?: QueryOptions
  ): Promise<R[]> {
    const conn = await this.getConnection();

    try {
      const bindParams = (values || []).map((v) => ({ val: v }));
      const result = await conn.execute(query, bindParams);

      return (result && result.rows) || [];
    } finally {
      await conn.close();
    }
  }

  public async stream(
    query: string,
    values: unknown[],
    { highWaterMark }: StreamOptions
  ) {
    const conn = await this.getConnection();

    try {
      const bindParams = (values || []).map((v) => ({ val: v }));
      const stream = conn.queryStream(query, bindParams, {
        outFormat: (dmdb as any).OUT_FORMAT_OBJECT,
        // highWaterMark applies to Node stream; dmdb will pass it through.
        highWaterMark,
      });

      const fields: TableStructure = await new Promise((resolve, reject) => {
        stream.on("metadata", (metadata: any[]) => {
          resolve(this.mapFields(metadata));
        });
        stream.on("error", (err: Error) => {
          reject(err);
        });
      });

      return {
        rowStream: stream,
        types: fields,
        release: async () => {
          stream.destroy();
          await conn.close();
        },
      };
    } catch (e) {
      await conn.close();
      throw e;
    }
  }

  private mapFields(metadata: any[]): TableStructure {
    return metadata.map((column) => {
      const dbTypeName = (column.dbTypeName || column.dbType || "").toString();

      return {
        name: column.name,
        type: this.toGenericType(dbTypeName, column.precision, column.scale),
      };
    });
  }

  public param(paramIndex: number): string {
    // DM uses Oracle-style positional binds: :1, :2, ...
    return `:${paramIndex + 1}`;
  }

  public override async tableColumnTypes(
    table: string
  ): Promise<TableStructure> {
    const [schema, name] = table.split(".");
    const owner = (schema || "").toUpperCase();
    const tableName = (name || "").toUpperCase();

    const columns = await this.query<TableColumnQueryResult>(
      `SELECT
         tc.COLUMN_NAME as ${this.quoteIdentifier("column_name")},
         tc.TABLE_NAME as ${this.quoteIdentifier("table_name")},
         tc.OWNER as ${this.quoteIdentifier("table_schema")},
         tc.DATA_TYPE as ${this.quoteIdentifier("data_type")},
         tc.DATA_PRECISION as ${this.quoteIdentifier("numeric_precision")},
         tc.DATA_SCALE as ${this.quoteIdentifier("numeric_scale")}
       FROM ALL_TAB_COLUMNS tc
       WHERE tc.TABLE_NAME = ${this.param(0)}
         AND tc.OWNER = ${this.param(1)}`,
      [tableName, owner]
    );

    return columns.map((c) => ({
      name: c.column_name,
      type: this.toGenericType(
        c.data_type,
        c.numeric_precision,
        c.numeric_scale
      ),
    }));
  }

  public getTablesQuery(schemaName: string): Promise<TableQueryResult[]> {
    const owner = schemaName.toUpperCase();

    return this.query<TableQueryResult>(
      `SELECT
         t.TABLE_NAME
       FROM ALL_TABLES t
       WHERE t.OWNER = ${this.param(0)}`,
      [owner]
    );
  }

  public async createSchemaIfNotExists(schemaName: string): Promise<void> {
    const owner = schemaName.toUpperCase();

    const schemas = await this.query(
      `SELECT USERNAME
       FROM ALL_USERS
       WHERE USERNAME = ${this.param(0)}`,
      [owner]
    );

    if (schemas.length === 0) {
      // DM is largely Oracle-compatible and supports CREATE SCHEMA.
      await this.query(`CREATE SCHEMA ${owner}`, []);
    }
  }

  public informationSchemaQuery(): string {
    return `
      SELECT
        tc.COLUMN_NAME as ${this.quoteIdentifier("column_name")},
        tc.TABLE_NAME as ${this.quoteIdentifier("table_name")},
        tc.OWNER as ${this.quoteIdentifier("table_schema")},
        tc.DATA_TYPE as ${this.quoteIdentifier("data_type")}
      FROM ALL_TAB_COLUMNS tc
      WHERE tc.OWNER NOT IN ('SYS', 'SYSTEM')
    `;
  }

  public async downloadQueryResults(
    query: string,
    values: unknown[],
    options: DownloadQueryResultsOptions
  ): Promise<DownloadQueryResultsResult> {
    if (options?.streamImport) {
      // Delegate to streaming implementation when bulk-loading into pre-aggregations.
      return this.stream(query, values, options);
    }

    return super.downloadQueryResults(query, values, options);
  }

  protected override fromGenericType(columnType: GenericDataBaseType): string {
    return GenericTypeToDm[columnType] || super.fromGenericType(columnType);
  }

  protected override toGenericType(
    columnType: string,
    precision?: number | null,
    scale?: number | null
  ): GenericDataBaseType {
    const lower = columnType.toLowerCase();
    return (DmToGenericType[lower] ||
      DmToGenericType[lower.split("(")[0]] ||
      super.toGenericType(columnType, precision, scale)) as GenericDataBaseType;
  }

  public readOnly(): boolean {
    return !!this.config.readOnly;
  }

  public wrapQueryWithLimit(query: { query: string; limit: number }) {
    // DM is Oracle-compatible; use ROWNUM for limiting rows.
    query.query = `SELECT * FROM (${query.query}) t WHERE ROWNUM <= ${query.limit}`;
  }

  public capabilities(): DriverCapabilities {
    return {
      incrementalSchemaLoading: true,
    };
  }

  public async release() {
    if (this.poolPromise) {
      const pool = await this.poolPromise;
      await pool.close();
      this.poolPromise = undefined;
    }
  }
}
