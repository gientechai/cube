import { SchemaFileRepository } from '@cubejs-backend/shared';
import type { Compiler, QueryFactory } from '@cubejs-backend/schema-compiler';
import { CompilerApi } from '../../src/core/CompilerApi';
import { DbTypeInternalFn } from '../../src/core/types';

// Test helper class to expose protected properties
class CompilerApiTestable extends CompilerApi {
  public getCompilersProperty(): Promise<Compiler> | any {
    return this.compilers;
  }

  public getQueryFactoryProperty(): QueryFactory | any {
    return this.queryFactory;
  }

  public mergeColumnAccessLevelsPublic(
    levels: Array<'plain' | 'masked' | 'denied'>,
    mode: 'and' | 'or'
  ) {
    return this.mergeColumnAccessLevels(levels, mode);
  }

  public resolvePermissionMergeModePublic(
    context: any,
    cube: any,
    key: 'rowMergeMode' | 'columnMergeMode',
    defaultMode: 'and' | 'or'
  ) {
    return this.resolvePermissionMergeMode(context, cube, key, defaultMode);
  }
}

describe('CompilerApi', () => {
  describe('Datart RBAC merge helpers', () => {
    let compilerApi: CompilerApiTestable;
    const mockRepository: SchemaFileRepository = {
      localPath: () => '/mock/path',
      dataSchemaFiles: () => Promise.resolve([]),
    };
    const mockDbType: DbTypeInternalFn = async () => 'postgres';

    beforeEach(() => {
      compilerApi = new CompilerApiTestable(mockRepository, mockDbType, {
        logger: () => {},
      });
    });

    afterEach(() => {
      compilerApi.dispose();
    });

    test('column OR merge denies when any role denies', () => {
      expect(compilerApi.mergeColumnAccessLevelsPublic(['plain', 'denied'], 'or')).toBe('denied');
      expect(compilerApi.mergeColumnAccessLevelsPublic(['plain', 'masked'], 'or')).toBe('plain');
    });

    test('column AND merge requires all roles to grant plain', () => {
      expect(compilerApi.mergeColumnAccessLevelsPublic(['plain', 'plain'], 'and')).toBe('plain');
      expect(compilerApi.mergeColumnAccessLevelsPublic(['plain', 'masked'], 'and')).toBe('masked');
      expect(compilerApi.mergeColumnAccessLevelsPublic(['plain', 'denied'], 'and')).toBe('denied');
    });

    test('resolvePermissionMergeMode prefers cube schema over security context and meta', () => {
      const context = { securityContext: { variables: { rowMergeMode: 'or' } } };
      const cube = {
        rowLevelMerge: 'and',
        meta: { datartPermission: { rowMergeMode: 'or' } },
      };
      expect(compilerApi.resolvePermissionMergeModePublic(context, cube, 'rowMergeMode', 'or')).toBe('and');
    });

    test('resolvePermissionMergeMode falls back to security context when cube schema is unset', () => {
      const context = { securityContext: { variables: { rowMergeMode: 'and' } } };
      const cube = { meta: { datartPermission: { rowMergeMode: 'or' } } };
      expect(compilerApi.resolvePermissionMergeModePublic(context, cube, 'rowMergeMode', 'or')).toBe('and');
      expect(compilerApi.resolvePermissionMergeModePublic({}, cube, 'columnMergeMode', 'and')).toBe('and');
    });

    test('resolvePermissionMergeMode reads snake_case cube schema fields', () => {
      const cube = { row_level_merge: 'and', member_level_merge: 'or' };
      expect(compilerApi.resolvePermissionMergeModePublic({}, cube, 'rowMergeMode', 'or')).toBe('and');
      expect(compilerApi.resolvePermissionMergeModePublic({}, cube, 'columnMergeMode', 'and')).toBe('or');
    });
  });

  describe('dispose', () => {
    let compilerApi: CompilerApiTestable;

    // Mock repository
    const mockRepository: SchemaFileRepository = {
      localPath: () => '/mock/path',
      dataSchemaFiles: () => Promise.resolve([
        {
          fileName: 'test.js',
          content: `
            cube('TestCube', {
              sql: 'SELECT * FROM test',
              measures: {
                count: {
                  type: 'count'
                }
              }
            });
          `
        }
      ])
    };

    // Mock dbType function
    const mockDbType: DbTypeInternalFn = async () => 'postgres';

    beforeEach(() => {
      compilerApi = new CompilerApiTestable(
        mockRepository,
        mockDbType,
        {
          logger: () => {}, // eslint-disable-line @typescript-eslint/no-empty-function
        }
      );
    });

    afterEach(() => {
      if (compilerApi) {
        compilerApi.dispose();
      }
    });

    test('should replace compilers with disposed proxy after dispose', async () => {
      await compilerApi.getCompilers();

      compilerApi.dispose();

      // Try to access compilers after dispose - should throw
      const compilers = compilerApi.getCompilersProperty();

      // Since compilers is now a disposed proxy (not a Promise),
      // any property access should throw immediately
      expect(() => compilers.cubeEvaluator).toThrow(/disposed CompilerApi instance/);
    });

    test('should replace queryFactory with disposed proxy after dispose', async () => {
      await compilerApi.getCompilers();

      compilerApi.dispose();

      // Try to access queryFactory - should throw
      const queryFactory = compilerApi.getQueryFactoryProperty();

      expect(() => queryFactory.createQuery).toThrow(/disposed CompilerApi instance/);
    });

    test('should set graphqlSchema to undefined on dispose', async () => {
      const mockSchema = {} as any;
      compilerApi.setGraphQLSchema(mockSchema);

      expect(compilerApi.getGraphQLSchema()).toBe(mockSchema);

      compilerApi.dispose();

      // Schema should be undefined
      expect(compilerApi.getGraphQLSchema()).toBeUndefined();
    });

    test('should be safe to call dispose multiple times', async () => {
      await compilerApi.getCompilers();

      compilerApi.dispose();
      compilerApi.dispose();
      compilerApi.dispose();

      // Should still throw on access
      const compilers = compilerApi.getCompilersProperty();

      expect(() => compilers.cubeEvaluator).toThrow(/disposed CompilerApi instance/);
    });
  });
});
