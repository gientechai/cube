/**
 * Result-stage desensitization handlers aligned with Java DesensitizationType.
 * See docs/internal/Cube行列权限-脱敏mask与result_mask说明.md
 */

export type DesensitizeType = 'NO_DESENSITIZE' | 'FULL_DESENSITIZE';

export type ResultMaskRule = {
  type: string;
  desensitize_type?: string;
  desensitizeType?: string;
  config?: Record<string, unknown>;
};

export type DesensitizationContext = {
  value: unknown;
  memberType?: string;
};

function asString(value: unknown): string {
  if (value == null) {
    return '';
  }
  return String(value).trim();
}

export function normalizeDesensitizeType(rule: ResultMaskRule): DesensitizeType {
  const raw = rule.desensitize_type ?? rule.desensitizeType ?? 'NO_DESENSITIZE';
  const normalized = String(raw).trim().replace(/[\s-]+/g, '_').toUpperCase();
  return normalized === 'FULL_DESENSITIZE' ? 'FULL_DESENSITIZE' : 'NO_DESENSITIZE';
}

function repeatChar(char: string, count: number): string {
  if (count <= 0) {
    return '';
  }
  return char.repeat(count);
}

function fullDesensitize(value: string, replaceChar = '*'): string {
  if (!value) {
    return replaceChar;
  }
  if (replaceChar.length === 1) {
    return repeatChar(replaceChar, value.length);
  }
  return replaceChar;
}

function applyFallback(
  original: string,
  desensitizeType: DesensitizeType,
  replaceChar = '*',
): string {
  if (desensitizeType === 'NO_DESENSITIZE') {
    return original;
  }
  return fullDesensitize(original, replaceChar);
}

function maskMiddleWithChar(value: string, maskChar: string): string {
  if (value.length <= 1) {
    return value;
  }
  return `${value[0]}${maskChar}${value[value.length - 1]}`;
}

function maskKeepPrefixSuffix(
  value: string,
  keepFirst: number,
  keepLast: number,
  replaceChar: string,
  desensitizeType: DesensitizeType,
): string {
  if (value.length <= keepFirst + keepLast) {
    return applyFallback(value, desensitizeType, replaceChar);
  }
  const prefix = value.slice(0, keepFirst);
  const suffix = value.slice(value.length - keepLast);
  const middleLen = value.length - keepFirst - keepLast;
  const middle = replaceChar.length === 1
    ? repeatChar(replaceChar, middleLen)
    : repeatChar(replaceChar, 1).repeat(middleLen);
  return `${prefix}${middle}${suffix}`;
}

export function desensitizeName(value: unknown, rule: ResultMaskRule): unknown {
  const str = asString(value);
  const fallback = normalizeDesensitizeType(rule);
  if (!str) {
    return applyFallback(str, fallback);
  }
  if (str.length === 1) {
    return applyFallback(str, fallback);
  }
  if (str.length === 2) {
    return `${str[0]}*`;
  }
  if (str.length === 3) {
    return `${str[0]}*${str[2]}`;
  }
  return `${str.slice(0, 2)}*${str.slice(3)}`;
}

export function desensitizeIdCard(value: unknown, rule: ResultMaskRule): unknown {
  const str = asString(value);
  const fallback = normalizeDesensitizeType(rule);
  if (str.length !== 18) {
    return applyFallback(str, fallback);
  }
  return `${str.slice(0, 6)}${repeatChar('*', 8)}${str.slice(14)}`;
}

export function desensitizePhone(value: unknown, rule: ResultMaskRule): unknown {
  const raw = value == null ? '' : String(value).trim();
  const fallback = normalizeDesensitizeType(rule);
  if (!raw) {
    return applyFallback(raw, fallback);
  }

  const digits = raw.replace(/\D/g, '');
  const mainland = /^1[3-9]\d{9}$/;
  if (mainland.test(digits)) {
    return `${digits.slice(0, 6)}***${digits.slice(8)}`;
  }

  const hk = /^[569]\d{7}$/;
  if (hk.test(digits)) {
    return `${digits.slice(0, 3)}***${digits.slice(6)}`;
  }

  const tw = /^09\d{8}$/;
  if (tw.test(digits)) {
    return `${digits.slice(0, 3)}***${digits.slice(7)}`;
  }

  if (raw.startsWith('+')) {
    const plusDigits = raw.slice(1).replace(/\D/g, '');
    if (plusDigits.length >= 4) {
      return `+${plusDigits.slice(0, 2)}***${plusDigits.slice(-2)}`;
    }
  }

  if (digits.length >= 4) {
    return `${digits.slice(0, 3)}***${digits.slice(-2)}`;
  }

  return applyFallback(raw, fallback);
}

export function desensitizeEmail(value: unknown, rule: ResultMaskRule): unknown {
  const str = asString(value);
  const fallback = normalizeDesensitizeType(rule);
  const atIndex = str.indexOf('@');
  const lastAt = str.lastIndexOf('@');
  if (atIndex <= 0 || atIndex !== lastAt) {
    return applyFallback(str, fallback);
  }
  const local = str.slice(0, atIndex);
  const domain = str.slice(atIndex);
  if (local.length >= 3) {
    return `${local.slice(0, 3)}***${domain}`;
  }
  return `${local}***${domain}`;
}

export function desensitizeBankCard(value: unknown, rule: ResultMaskRule): unknown {
  const str = asString(value);
  const fallback = normalizeDesensitizeType(rule);
  if (str.length < 11) {
    return applyFallback(str, fallback);
  }
  return `${str.slice(0, 6)}${repeatChar('*', str.length - 10)}${str.slice(-4)}`;
}

export function desensitizeAccount(value: unknown, rule: ResultMaskRule): unknown {
  const str = asString(value);
  const fallback = normalizeDesensitizeType(rule);
  if (!str) {
    return '';
  }
  if (str.length < 9) {
    return applyFallback(str, fallback);
  }
  return `${str.slice(0, 4)}${repeatChar('*', str.length - 8)}${str.slice(-4)}`;
}

export function desensitizeAddress(value: unknown, rule: ResultMaskRule): unknown {
  const str = asString(value);
  const fallback = normalizeDesensitizeType(rule);
  if (!str) {
    return applyFallback(str, fallback);
  }

  const adminMatch = str.match(/^(.+?(?:省|市|自治区|特别行政区|区|县|旗|州|盟|岛))/);
  if (adminMatch) {
    const admin = adminMatch[1];
    const rest = str.slice(admin.length);
    if (!rest) {
      return admin;
    }
    const roadMatch = rest.match(/^(.+?(?:路|街|道|巷|弄|里|村|镇|乡|小区|大厦|广场|号|室|楼|栋|单元))/);
    if (roadMatch) {
      return `${admin}${roadMatch[1]}**`;
    }
    return `${admin}**`;
  }

  const roadMatch = str.match(/^(.+?(?:路|街|道|巷|弄|里|村|镇|乡|小区|大厦|广场|号|室|楼|栋|单元))/);
  if (roadMatch) {
    return `${roadMatch[1]}**`;
  }

  return applyFallback(str, fallback, '*');
}

export function desensitizeKeepPrefixSuffix(value: unknown, rule: ResultMaskRule): unknown {
  const str = asString(value);
  const config = rule.config || {};
  const fallback = normalizeDesensitizeType(rule);
  const keepFirst = Number(config.keepFirstCount);
  const keepLast = Number(config.keepLastCount);
  const replaceChar = String(config.replaceChar ?? '*');
  if (!Number.isFinite(keepFirst) || !Number.isFinite(keepLast) || !config.replaceChar) {
    return applyFallback(str, fallback, replaceChar);
  }
  return maskKeepPrefixSuffix(str, keepFirst, keepLast, replaceChar, fallback);
}

export function desensitizeKeepRange(value: unknown, rule: ResultMaskRule): unknown {
  const str = asString(value);
  const config = rule.config || {};
  const fallback = normalizeDesensitizeType(rule);
  const keepFrom = Number(config.keepFromCount);
  const keepTo = Number(config.keepToCount);
  const replaceChar = String(config.replaceChar ?? '*');
  if (
    !Number.isFinite(keepFrom) ||
    !Number.isFinite(keepTo) ||
    keepFrom < 1 ||
    keepTo < keepFrom ||
    !config.replaceChar
  ) {
    return applyFallback(str, fallback, replaceChar);
  }
  if (keepTo > str.length) {
    return applyFallback(str, fallback, replaceChar);
  }
  const prefix = str.slice(0, keepFrom - 1);
  const kept = str.slice(keepFrom - 1, keepTo);
  const suffix = str.slice(keepTo);
  const maskedPrefix = replaceChar.length === 1
    ? repeatChar(replaceChar, prefix.length)
    : repeatChar(replaceChar, 1).repeat(prefix.length);
  const maskedSuffix = replaceChar.length === 1
    ? repeatChar(replaceChar, suffix.length)
    : repeatChar(replaceChar, 1).repeat(suffix.length);
  return `${maskedPrefix}${kept}${maskedSuffix}`;
}

function parseSpecialChars(config: Record<string, unknown>): string[] | null {
  const raw = config.specialChars;
  if (Array.isArray(raw)) {
    return raw.map(String);
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(String) : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function desensitizeKeepSpecialChar(value: unknown, rule: ResultMaskRule): unknown {
  const str = asString(value);
  const config = rule.config || {};
  const fallback = normalizeDesensitizeType(rule);
  const replaceChar = String(config.replaceChar ?? '*');
  const specialChars = parseSpecialChars(config);
  if (!specialChars?.length || !config.replaceChar) {
    return applyFallback(str, fallback, replaceChar);
  }
  if (!str) {
    return '';
  }
  const preserve = new Set(specialChars);
  if (![...str].some(ch => preserve.has(ch))) {
    return applyFallback(str, fallback, replaceChar);
  }
  return [...str].map(ch => (preserve.has(ch) ? ch : replaceChar)).join('');
}

export function desensitizeBeforeSpecialChar(value: unknown, rule: ResultMaskRule): unknown {
  const str = asString(value);
  const config = rule.config || {};
  const fallback = normalizeDesensitizeType(rule);
  const specialChar = String(config.specialChar ?? '');
  const display = String(config.desensitizeDisplay ?? '*');
  if (!specialChar || !config.desensitizeDisplay) {
    return applyFallback(str, fallback, display);
  }
  if (!str) {
    return '';
  }
  const index = str.indexOf(specialChar);
  if (index < 0) {
    return applyFallback(str, fallback, display);
  }
  const masked = display.length === 1
    ? repeatChar(display, index)
    : display;
  return `${masked}${str.slice(index)}`;
}

export function desensitizeAfterSpecialChar(value: unknown, rule: ResultMaskRule): unknown {
  const str = asString(value);
  const config = rule.config || {};
  const fallback = normalizeDesensitizeType(rule);
  const specialChar = String(config.specialChar ?? '');
  const display = String(config.desensitizeDisplay ?? '*');
  if (!specialChar || !config.desensitizeDisplay) {
    return applyFallback(str, fallback, display);
  }
  if (!str) {
    return '';
  }
  const index = str.indexOf(specialChar);
  if (index < 0) {
    return applyFallback(str, fallback, display);
  }
  const tailLen = str.length - index - specialChar.length;
  const maskedTail = display.length === 1
    ? repeatChar(display, tailLen)
    : display;
  return `${str.slice(0, index + specialChar.length)}${maskedTail}`;
}

export function desensitizeFull(value: unknown, rule: ResultMaskRule): unknown {
  const config = rule.config || {};
  const display = config.desensitizeDisplay;
  if (display === undefined || display === null) {
    return '***';
  }
  return String(display);
}

export function desensitizeCharReplace(value: unknown, rule: ResultMaskRule): unknown {
  const str = asString(value);
  const config = rule.config || {};
  const fallback = normalizeDesensitizeType(rule);
  const replaceRules = config.replaceRules;
  if (!Array.isArray(replaceRules) || !replaceRules.length) {
    return applyFallback(str, fallback);
  }

  const sorted = [...replaceRules]
    .filter(item => item && item.sourceChar != null && item.targetChar != null)
    .sort((a, b) => String(b.sourceChar).length - String(a.sourceChar).length);

  if (!sorted.length) {
    return applyFallback(str, fallback);
  }

  let result = '';
  let index = 0;
  while (index < str.length) {
    let matched = false;
    for (const item of sorted) {
      const source = String(item.sourceChar);
      if (str.startsWith(source, index)) {
        result += String(item.targetChar);
        index += source.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      result += str[index];
      index += 1;
    }
  }

  if (result === str) {
    return applyFallback(str, fallback);
  }
  return result;
}

export function desensitizeRegex(value: unknown, rule: ResultMaskRule): unknown {
  const str = asString(value);
  const config = rule.config || {};
  const fallback = normalizeDesensitizeType(rule);
  const pattern = config.regex;
  const replacement = config.replacementString;
  if (typeof pattern !== 'string' || typeof replacement !== 'string') {
    return applyFallback(str, fallback);
  }
  try {
    const regex = new RegExp(pattern);
    if (!regex.test(str)) {
      return applyFallback(str, fallback);
    }
    return str.replace(regex, replacement);
  } catch {
    return applyFallback(str, fallback);
  }
}
