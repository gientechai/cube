import {
  applyResultMaskRule,
  normalizeResultMaskRule,
  type ResultMaskRule,
  type ResultMaskedMemberItem,
} from './member-result-mask-strategies';
import {
  remapFilterMemberToRowKey,
  resolveRowKey,
  rowMatchesMaskFilter,
} from './member-mask-filter';

export {
  DesensitizationType,
  ResultMaskRuleType,
  registerResultMaskStrategy,
  applyResultMaskRule,
  normalizeResultMaskRule,
  type ResultMaskedMemberItem,
} from './member-result-mask-strategies';
export { memberPathToRowKey, remapFilterMemberToRowKey, resolveRowKey, rowMatchesMaskFilter } from './member-mask-filter';

type LegacyMaskedMemberItem = {
  member: string;
  filter?: any;
  result_mask?: ResultMaskRule;
};

/**
 * Apply result-stage `result_mask` rules to query result rows.
 * Rules come from `query.resultMaskedMembers` (access_policy.member_masking.rules).
 */
export function applyResultMaskedMembersToRows(
  rows: Array<Record<string, unknown>>,
  resultMaskedMembers: Array<ResultMaskedMemberItem | LegacyMaskedMemberItem>,
  resolveMemberType?: (memberPath: string) => string | undefined,
): Array<Record<string, unknown>> {
  if (!resultMaskedMembers.length || !rows.length) {
    return rows;
  }

  return rows.map((row) => {
    const maskedRow = { ...row };

    resultMaskedMembers.forEach((item) => {
      const { member, filter } = item;
      const rowKey = resolveRowKey(maskedRow, member);
      if (!rowKey) {
        return;
      }

      const resultMask = normalizeResultMaskRule(
        'result_mask' in item ? item.result_mask : undefined,
      );
      if (!resultMask) {
        return;
      }

      const normalizedFilter = filter ? remapFilterMemberToRowKey(filter) : filter;
      if (normalizedFilter && rowMatchesMaskFilter(maskedRow, normalizedFilter)) {
        return;
      }

      maskedRow[rowKey] = applyResultMaskRule(resultMask, {
        value: maskedRow[rowKey],
        memberType: resolveMemberType?.(member),
        memberPath: member,
        row: maskedRow,
      });
    });

    return maskedRow;
  });
}
