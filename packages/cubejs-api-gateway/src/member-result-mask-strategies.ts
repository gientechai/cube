import { getEnv } from '@cubejs-backend/shared';
import {
  desensitizeAccount,
  desensitizeAddress,
  desensitizeAfterSpecialChar,
  desensitizeBankCard,
  desensitizeBeforeSpecialChar,
  desensitizeCharReplace,
  desensitizeEmail,
  desensitizeFull,
  desensitizeIdCard,
  desensitizeKeepPrefixSuffix,
  desensitizeKeepRange,
  desensitizeKeepSpecialChar,
  desensitizeName,
  desensitizePhone,
  desensitizeRegex,
  type DesensitizeType,
  type ResultMaskRule,
} from './desensitization-handlers';

export {
  DesensitizeType,
  ResultMaskRule,
  normalizeDesensitizeType,
} from './desensitization-handlers';

/** Java DesensitizationType enum ids. */
export const DesensitizationType = {
  NAME: 'NAME',
  ID_CARD: 'ID_CARD',
  PHONE: 'PHONE',
  ADDRESS: 'ADDRESS',
  EMAIL: 'EMAIL',
  BANK_CARD: 'BANK_CARD',
  ACCOUNT: 'ACCOUNT',
  KEEP_PREFIX_SUFFIX: 'KEEP_PREFIX_SUFFIX',
  KEEP_RANGE: 'KEEP_RANGE',
  KEEP_SPECIAL_CHAR: 'KEEP_SPECIAL_CHAR',
  BEFORE_SPECIAL_CHAR: 'BEFORE_SPECIAL_CHAR',
  AFTER_SPECIAL_CHAR: 'AFTER_SPECIAL_CHAR',
  FULL: 'FULL',
  CHAR_REPLACE: 'CHAR_REPLACE',
  REGEX: 'REGEX',
} as const;

export type ResultMaskContext = {
  value: unknown;
  memberType?: string;
  memberPath?: string;
  row?: Record<string, unknown>;
};

export type ResultMaskStrategy = (
  context: ResultMaskContext,
  rule: ResultMaskRule,
) => unknown;

const resultMaskStrategies = new Map<string, ResultMaskStrategy>();

export function normalizeResultMaskRuleType(type: string): string {
  return type.trim().replace(/[\s-]+/g, '_').toUpperCase();
}

export function registerResultMaskStrategy(type: string, strategy: ResultMaskStrategy): void {
  resultMaskStrategies.set(normalizeResultMaskRuleType(type), strategy);
}

export function hasResultMaskStrategy(type: string): boolean {
  return resultMaskStrategies.has(normalizeResultMaskRuleType(type));
}

function defaultMaskForType(memberType: string | undefined): unknown {
  switch (memberType) {
    case 'time':
      return getEnv('accessPolicyMaskTime');
    case 'boolean':
      return getEnv('accessPolicyMaskBoolean');
    case 'number':
      return getEnv('accessPolicyMaskNumber');
    default:
      return getEnv('accessPolicyMaskString');
  }
}

function wrapHandler(
  handler: (value: unknown, rule: ResultMaskRule) => unknown,
): ResultMaskStrategy {
  return (context, rule) => handler(context.value, rule);
}

registerResultMaskStrategy(DesensitizationType.NAME, wrapHandler(desensitizeName));
registerResultMaskStrategy(DesensitizationType.ID_CARD, wrapHandler(desensitizeIdCard));
registerResultMaskStrategy(DesensitizationType.PHONE, wrapHandler(desensitizePhone));
registerResultMaskStrategy(DesensitizationType.ADDRESS, wrapHandler(desensitizeAddress));
registerResultMaskStrategy(DesensitizationType.EMAIL, wrapHandler(desensitizeEmail));
registerResultMaskStrategy(DesensitizationType.BANK_CARD, wrapHandler(desensitizeBankCard));
registerResultMaskStrategy(DesensitizationType.ACCOUNT, wrapHandler(desensitizeAccount));
registerResultMaskStrategy(DesensitizationType.KEEP_PREFIX_SUFFIX, wrapHandler(desensitizeKeepPrefixSuffix));
registerResultMaskStrategy(DesensitizationType.KEEP_RANGE, wrapHandler(desensitizeKeepRange));
registerResultMaskStrategy(DesensitizationType.KEEP_SPECIAL_CHAR, wrapHandler(desensitizeKeepSpecialChar));
registerResultMaskStrategy(DesensitizationType.BEFORE_SPECIAL_CHAR, wrapHandler(desensitizeBeforeSpecialChar));
registerResultMaskStrategy(DesensitizationType.AFTER_SPECIAL_CHAR, wrapHandler(desensitizeAfterSpecialChar));
registerResultMaskStrategy(DesensitizationType.FULL, wrapHandler(desensitizeFull));
registerResultMaskStrategy(DesensitizationType.CHAR_REPLACE, wrapHandler(desensitizeCharReplace));
registerResultMaskStrategy(DesensitizationType.REGEX, wrapHandler(desensitizeRegex));

export function normalizeResultMaskRule(raw: unknown): ResultMaskRule | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const rule = raw as Record<string, unknown>;
  if (typeof rule.type !== 'string' || !rule.type.trim()) {
    return undefined;
  }
  return {
    type: rule.type,
    desensitize_type: (rule.desensitize_type ?? rule.desensitizeType) as string | undefined,
    desensitizeType: (rule.desensitizeType ?? rule.desensitize_type) as string | undefined,
    config: (rule.config && typeof rule.config === 'object' && !Array.isArray(rule.config))
      ? rule.config as Record<string, unknown>
      : {},
  };
}

export function applyResultMaskRule(
  rule: ResultMaskRule,
  context: ResultMaskContext,
): unknown {
  const strategy = resultMaskStrategies.get(normalizeResultMaskRuleType(rule.type));
  if (!strategy) {
    return defaultMaskForType(context.memberType);
  }
  return strategy(context, rule);
}

export type ResultMaskedMemberItem = {
  member: string;
  filter?: any;
  result_mask: ResultMaskRule;
};

export type MemberResultMaskDefinition = {
  type?: string;
  result_mask?: ResultMaskRule;
  resultMask?: ResultMaskRule;
};

export function resolveMemberResultMaskRule(
  memberDef: MemberResultMaskDefinition | undefined,
): ResultMaskRule | undefined {
  return normalizeResultMaskRule(memberDef?.result_mask ?? memberDef?.resultMask);
}

export function applyMemberResultMask(
  value: unknown,
  memberDef: MemberResultMaskDefinition | undefined,
  row?: Record<string, unknown>,
  memberPath?: string,
): unknown {
  const resultMask = resolveMemberResultMaskRule(memberDef);
  if (!resultMask) {
    return value;
  }

  return applyResultMaskRule(resultMask, {
    value,
    memberType: memberDef?.type,
    memberPath,
    row,
  });
}

/** @deprecated Use DesensitizationType */
export const ResultMaskRuleType = DesensitizationType;
