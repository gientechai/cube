/**
 * GBase 8a driver based on MySQL wire protocol (via `mysql` client).
 *
 * GBase 8a is MySQL-compatible for most SQL surface. There is no official
 * Node.js driver from GBase; this package wraps the same client stack as
 * `@cubejs-backend/mysql-driver` with GBase-specific defaults.
 */
import { getEnv, assertDataSource } from '@cubejs-backend/shared';
import {
  DownloadQueryResultsOptions,
  DownloadQueryResultsResult,
  StreamOptions,
} from '@cubejs-backend/base-driver';
import {
  MySqlDriver,
  MySqlDriverConfiguration,
} from '@cubejs-backend/mysql-driver';

/** Default GBase 8a port when CUBEJS_DB_PORT is not set. */
export const GBASE_DEFAULT_PORT = 5050;

const SESSION_TIMEZONE_PATTERN = /@@session\.time_zone/gi;

export type GBaseDriverConfiguration = MySqlDriverConfiguration;

/**
 * GBase 8a driver class.
 */
export class GBaseDriver extends MySqlDriver {
  /**
   * Returns default concurrency value.
   */
  public static getDefaultConcurrency(): number {
    return 2;
  }

  /**
   * Environment variables used by this driver.
   */
  public static driverEnvVariables() {
    return [
      'CUBEJS_DB_HOST',
      'CUBEJS_DB_NAME',
      'CUBEJS_DB_PORT',
      'CUBEJS_DB_USER',
      'CUBEJS_DB_PASS',
    ];
  }

  /**
   * Class constructor.
   */
  public constructor(
    config: GBaseDriverConfiguration & {
      dataSource?: string;
      preAggregations?: boolean;
      maxPoolSize?: number;
      testConnectionTimeout?: number;
    } = {}
  ) {
    const dataSource =
      config.dataSource ||
      assertDataSource('default');
    const preAggregations = config.preAggregations || false;

    const port =
      config.port ??
      getEnv('dbPort', { dataSource, preAggregations }) ??
      GBASE_DEFAULT_PORT;

    super({
      ...config,
      port,
      storeTimezone: config.storeTimezone ?? '+00:00',
    });
  }

  /**
   * GBase gnode rejects `@@session.time_zone` (maps to missing get_system_var()).
   * Session TZ is forced to storeTimezone on connect; inline that literal.
   */
  protected normalizeQueryForGBase(query: string): string {
    const tz = this.config.storeTimezone || '+00:00';
    return query.replace(SESSION_TIMEZONE_PATTERN, `'${tz}'`);
  }

  protected setTimeZone(conn: { execute: (sql: string, values?: unknown[]) => Promise<unknown> }) {
    return super.setTimeZone(conn as never).then(() =>
      conn.execute('SET _t_gcluster_support_cte = 1', []).catch(() => undefined));
  }

  public async query<R = unknown>(query: string, values: unknown[]): Promise<R[]> {
    return super.query(this.normalizeQueryForGBase(query), values);
  }

  public async stream(
    query: string,
    values: unknown[],
    options: StreamOptions
  ) {
    return super.stream(this.normalizeQueryForGBase(query), values, options);
  }

  public async downloadQueryResults(
    query: string,
    values: unknown[],
    options: DownloadQueryResultsOptions
  ): Promise<DownloadQueryResultsResult> {
    return super.downloadQueryResults(
      this.normalizeQueryForGBase(query),
      values,
      options
    );
  }
}
