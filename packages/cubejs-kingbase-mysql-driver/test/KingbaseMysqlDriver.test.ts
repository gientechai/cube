import { KingbaseMysqlDriver, KingbaseMysqlQuery } from '../src';

describe('Kingbase MySQL Driver', () => {
  test('exposes the Kingbase MySQL dialect hook', () => {
    expect(KingbaseMysqlDriver.dialectClass()).toBe(KingbaseMysqlQuery);
  });
});
