import {
  PostgresDriver,
  PostgresDriverConfiguration,
} from '@cubejs-backend/postgres-driver';
import {
  DownloadQueryResultsOptions,
  DownloadQueryResultsResult,
  QueryOptions,
  StreamOptions,
  StreamTableDataWithTypes,
} from '@cubejs-backend/base-driver';
import { KingbaseOracleQuery } from './KingbaseOracleQuery';
import { normalizeKingbaseOraclePlaceholders } from './KingbaseOraclePlaceholder';

export type KingbaseOracleDriverConfiguration = PostgresDriverConfiguration;

export class KingbaseOracleDriver<
  Config extends KingbaseOracleDriverConfiguration = KingbaseOracleDriverConfiguration
> extends PostgresDriver<Config> {
  public static dialectClass() {
    return KingbaseOracleQuery;
  }

  public override async query<R = unknown>(
    query: string,
    values: unknown[],
    options?: QueryOptions
  ): Promise<R[]> {
    const normalized = normalizeKingbaseOraclePlaceholders(query, values);
    return super.query(normalized.sql, normalized.values, options);
  }

  public override async stream(
    query: string,
    values: unknown[],
    options: StreamOptions
  ): Promise<StreamTableDataWithTypes> {
    const normalized = normalizeKingbaseOraclePlaceholders(query, values);
    return super.stream(normalized.sql, normalized.values, options);
  }

  public override async downloadQueryResults(
    query: string,
    values: unknown[],
    options: DownloadQueryResultsOptions
  ): Promise<DownloadQueryResultsResult> {
    const normalized = normalizeKingbaseOraclePlaceholders(query, values);
    return super.downloadQueryResults(normalized.sql, normalized.values, options);
  }
}
