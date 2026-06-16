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
import { KingbaseMysqlQuery } from './KingbaseMysqlQuery';
import { normalizeKingbaseMysqlPlaceholders } from './KingbaseMysqlPlaceholder';

export type KingbaseMysqlDriverConfiguration = PostgresDriverConfiguration;

export class KingbaseMysqlDriver<
  Config extends KingbaseMysqlDriverConfiguration = KingbaseMysqlDriverConfiguration
> extends PostgresDriver<Config> {
  public static dialectClass() {
    return KingbaseMysqlQuery;
  }

  public override async query<R = unknown>(
    query: string,
    values: unknown[],
    options?: QueryOptions
  ): Promise<R[]> {
    const normalized = normalizeKingbaseMysqlPlaceholders(query, values);
    return super.query(normalized.sql, normalized.values, options);
  }

  public override async stream(
    query: string,
    values: unknown[],
    options: StreamOptions
  ): Promise<StreamTableDataWithTypes> {
    const normalized = normalizeKingbaseMysqlPlaceholders(query, values);
    return super.stream(normalized.sql, normalized.values, options);
  }

  public override async downloadQueryResults(
    query: string,
    values: unknown[],
    options: DownloadQueryResultsOptions
  ): Promise<DownloadQueryResultsResult> {
    const normalized = normalizeKingbaseMysqlPlaceholders(query, values);
    return super.downloadQueryResults(normalized.sql, normalized.values, options);
  }
}
