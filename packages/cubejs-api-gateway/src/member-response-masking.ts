import {
  applyResultMaskRule,
  normalizeResultMaskRule,
  type ResultMaskRule,
  type ResultMaskedMemberItem,
} from './member-result-mask-strategies';
import { rowMatchesMaskFilter } from './member-mask-filter';

export {
  DesensitizationType,
  ResultMaskRuleType,
  registerResultMaskStrategy,
  applyResultMaskRule,
  normalizeResultMaskRule,
  type ResultMaskedMemberItem,
} from './member-result-mask-strategies';
export { rowMatchesMaskFilter } from './member-mask-filter';

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
      if (!(member in maskedRow)) {
        return;
      }

      const resultMask = normalizeResultMaskRule(
        'result_mask' in item ? item.result_mask : undefined,
      );
      if (!resultMask) {
        return;
      }

      if (filter && rowMatchesMaskFilter(maskedRow, filter)) {
        return;
      }

      maskedRow[member] = applyResultMaskRule(resultMask, {
        value: maskedRow[member],
        memberType: resolveMemberType?.(member),
        memberPath: member,
        row: maskedRow,
      });
    });

    return maskedRow;
  });
}
