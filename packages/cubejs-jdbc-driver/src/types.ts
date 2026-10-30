import { PoolOptions } from '@cubejs-backend/shared';

export type JDBCDriverConfiguration = {
  database: string,
  dbType: string,
  url: string,
  drivername: string,
  /**
   * Local JDBC jar(s) or a directory already resolved by the caller.
   * GBase/MySQL paths use an array; a single string is kept for backward compatibility.
   */
  customClassPath?: string | string[],
  properties: Record<string, any>,
  poolOptions?: PoolOptions;
  prepareConnectionQueries?: string[];
  /** Hive/TBDS Kerberos settings, normally copied from the Java source config. */
  enableKerberos?: boolean;
  principal?: string;
  keytabPath?: string;
  krb5ConfPath?: string;
  kerberosParam?: Record<string, any>;
};
