import {
  PostgresDriver,
  PostgresDriverConfiguration,
} from '@cubejs-backend/postgres-driver';
import { KingbasePgQuery } from './KingbasePgQuery';

export type KingbasePgDriverConfiguration = PostgresDriverConfiguration;

export class KingbasePgDriver<
  Config extends KingbasePgDriverConfiguration = KingbasePgDriverConfiguration
> extends PostgresDriver<Config> {
  public static dialectClass() {
    return KingbasePgQuery;
  }
}
