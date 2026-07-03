import {
  DesensitizationType,
  applyResultMaskRule,
  registerResultMaskStrategy,
} from '../src/member-result-mask-strategies';
import { applyResultMaskedMembersToRows, rowMatchesMaskFilter } from '../src/member-response-masking';

describe('desensitization-handlers', () => {
  test('NAME masks two-character names', () => {
    expect(applyResultMaskRule(
      { type: DesensitizationType.NAME, desensitize_type: 'NO_DESENSITIZE', config: {} },
      { value: '张三' },
    )).toBe('张*');
  });

  test('EMAIL keeps domain and masks local part', () => {
    expect(applyResultMaskRule(
      { type: DesensitizationType.EMAIL, desensitize_type: 'NO_DESENSITIZE', config: {} },
      { value: 'user@example.com' },
    )).toBe('use***@example.com');
  });

  test('FULL returns configured display value', () => {
    expect(applyResultMaskRule(
      {
        type: DesensitizationType.FULL,
        desensitize_type: 'NO_DESENSITIZE',
        config: { desensitizeDisplay: '***' },
      },
      { value: 'secret' },
    )).toBe('***');
  });

  test('custom strategies can be registered', () => {
    registerResultMaskStrategy('CUSTOM_ID', ({ value }) => `ID:${value}`);
    expect(applyResultMaskRule(
      { type: 'CUSTOM_ID', config: {} },
      { value: '42' },
    )).toBe('ID:42');
  });
});

describe('member-response-masking', () => {
  test('applies result_mask using orchestrator row keys (cube__member)', () => {
    const rows = applyResultMaskedMembersToRows(
      [{ orders__amount: 1001 }],
      [{
        member: 'orders.amount',
        result_mask: {
          type: DesensitizationType.FULL,
          desensitize_type: 'NO_DESENSITIZE',
          config: { desensitizeDisplay: '-1' },
        },
      }],
    );

    expect(rows[0].orders__amount).toBe(-1);
  });

  test('applies result_mask from resultMaskedMembers rows', () => {
    const rows = applyResultMaskedMembersToRows(
      [
        { 'users.name': '张三' },
        { 'users.name': '张三丰' },
      ],
      [{
        member: 'users.name',
        result_mask: {
          type: DesensitizationType.NAME,
          desensitize_type: 'NO_DESENSITIZE',
          config: {},
        },
      }],
    );

    expect(rows).toEqual([
      { 'users.name': '张*' },
      { 'users.name': '张*丰' },
    ]);
  });

  test('skips items without result_mask rule', () => {
    const rows = applyResultMaskedMembersToRows(
      [{ 'users.name': '张三' }],
      [{ member: 'users.name', result_mask: { type: '', config: {} } }],
    );

    expect(rows[0]['users.name']).toBe('张三');
  });

  test('keeps original value when conditional mask filter matches', () => {
    const rows = applyResultMaskedMembersToRows(
      [{ 'users.city': 'NY', 'users.owner_id': '42' }],
      [{
        member: 'users.city',
        filter: {
          member: 'users.owner_id',
          operator: 'equals',
          values: ['42'],
        },
        result_mask: {
          type: DesensitizationType.FULL,
          desensitize_type: 'NO_DESENSITIZE',
          config: { desensitizeDisplay: 'MASKED' },
        },
      }],
    );

    expect(rows[0]['users.city']).toBe('NY');
  });

  test('rowMatchesMaskFilter supports equals operator', () => {
    expect(rowMatchesMaskFilter(
      { 'users.owner_id': '42' },
      { member: 'users.owner_id', operator: 'equals', values: ['42'] },
    )).toBe(true);
  });
});
